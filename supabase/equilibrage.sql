-- =====================================================================
--  equilibrage.sql — fermer l'aller-retour, et remettre les avantages
--  d'équipe à leur prix
--
--  DEUX CONSTATS, CHIFFRÉS SUR LES DONNÉES DU 9 OCTOBRE
--
--  1. L'ALLER-RETOUR. Runailen a enchaîné achat → vente → achat sur
--     PLT en une minute. Le mécanisme est ouvert : un cours ne bouge
--     qu'une fois par créneau de cinq minutes, donc il suffit de
--     vendre quand le créneau est vert et de garder quand il est rouge.
--     Avec 1 % de frais contre des créneaux qui bougent de 3 à 6 % sur
--     une spéculative, la friction ne pèse rien.
--
--  2. LES AVANTAGES D'ÉQUIPE. Les joueurs gagnent entre 244 et 2 079 or
--     par jour, médiane autour de 630. Sur vingt et un jours, cela fait
--     près de 17 000 or chacun — soit huit lots de 25 LP, 200 LP
--     achetés. Or l'écart de LP entre le premier et le dernier du
--     classement est du même ordre. La boutique pesait donc autant que
--     le jeu, et la bourse ne fait qu'aggraver le déséquilibre.
--
--  TROIS VERROUS PLUTÔT QU'UN
--  Les frais seuls ne feraient que taxer l'aller-retour. On y ajoute
--  une durée de détention, qui l'empêche, et un plafond quotidien, qui
--  empêche de le contourner en changeant de société à chaque fois.
--  Chacun répond à une faille différente.
--
--  À lancer après bourse.sql. Idempotent.
-- =====================================================================

-- La date du dernier achat sur une ligne : c'est elle qui ouvre le
-- droit de vendre.
alter table public.bourse_positions
  add column if not exists achete_le timestamptz not null default now();


-- ---------------------------------------------------------------------
--  1. LES RÉGLAGES, EN UN SEUL ENDROIT
--     Trois fonctions les lisent. Les changer ici les change partout,
--     et le site les affiche en les relisant.
-- ---------------------------------------------------------------------
create or replace function public.bourse_frais()      returns numeric language sql immutable as $$ select 0.02 $$;
create or replace function public.bourse_detention()  returns interval language sql immutable as $$ select interval '30 minutes' $$;
create or replace function public.bourse_max_jour()   returns int     language sql immutable as $$ select 12 $$;

grant execute on function public.bourse_frais()     to anon, authenticated;
grant execute on function public.bourse_detention() to anon, authenticated;
grant execute on function public.bourse_max_jour()  to anon, authenticated;

-- Combien d'ordres un joueur a déjà passés aujourd'hui, heure de Paris.
-- On compte dans le journal d'or : il porte déjà chaque ordre, et un
-- compteur à part finirait par mentir.
create or replace function public.bourse_ordres_du_jour(p_player text)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.gold_ledger
   where player_id = p_player
     and raison like 'bourse : %'
     and (at at time zone 'Europe/Paris')::date = (now() at time zone 'Europe/Paris')::date;
$$;
grant execute on function public.bourse_ordres_du_jour(text) to anon, authenticated;


-- ---------------------------------------------------------------------
--  2. ACHETER
-- ---------------------------------------------------------------------
create or replace function public.bourse_acheter(p_code text, p_nb int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix numeric; cout int; frais int;
        pos public.bourse_positions; n_jour int;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if p_nb is null or p_nb < 1 then raise exception 'Quantité invalide'; end if;
  if not exists (select 1 from public.bourse_societes where code = p_code and actif) then
    raise exception 'Société inconnue ou retirée de la cote';
  end if;

  n_jour := public.bourse_ordres_du_jour(moi.id);
  if n_jour >= public.bourse_max_jour() then
    raise exception 'Tu as déjà passé tes % ordres du jour. La bourse rouvre pour toi demain.',
      public.bourse_max_jour();
  end if;

  prix  := public.bourse_cours_actuel(p_code);
  cout  := round(prix * p_nb);
  frais := greatest(1, round(cout * public.bourse_frais()));
  if moi.gold < cout + frais then
    raise exception 'Il te manque % or', cout + frais - moi.gold;
  end if;

  update public.players set gold = gold - cout - frais where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -(cout + frais), 'bourse : achat ' || p_nb || ' × ' || p_code);

  select * into pos from public.bourse_positions where player_id = moi.id and code = p_code;
  if found then
    /* Racheter remet le compteur de détention à zéro sur TOUTE la
       ligne. Sans cela, on garderait une part éternellement pour
       pouvoir revendre aussitôt tout ce qu'on vient d'acheter. */
    update public.bourse_positions
       set pru = (pos.pru * pos.nb + cout) / (pos.nb + p_nb),
           nb = pos.nb + p_nb,
           achete_le = now()
     where player_id = moi.id and code = p_code;
  else
    insert into public.bourse_positions (player_id, code, nb, pru, achete_le)
    values (moi.id, p_code, p_nb, prix, now());
  end if;

  return jsonb_build_object('code', p_code, 'nb', p_nb, 'prix', prix,
                            'cout', cout, 'frais', frais, 'or', moi.gold - cout - frais,
                            'ordres', n_jour + 1, 'max', public.bourse_max_jour());
end $$;


-- ---------------------------------------------------------------------
--  3. VENDRE
-- ---------------------------------------------------------------------
create or replace function public.bourse_vendre(p_code text, p_nb int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix numeric; brut int; frais int;
        pos public.bourse_positions; n_jour int; reste_min int;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if p_nb is null or p_nb < 1 then raise exception 'Quantité invalide'; end if;

  select * into pos from public.bourse_positions
   where player_id = moi.id and code = p_code for update;
  if not found or pos.nb < p_nb then raise exception 'Tu n''en as pas autant'; end if;

  -- La durée de détention : c'est elle qui ferme l'aller-retour. Les
  -- frais ne font que le rendre cher, la durée le rend impossible.
  if pos.achete_le + public.bourse_detention() > now() then
    reste_min := ceil(extract(epoch from
      (pos.achete_le + public.bourse_detention() - now())) / 60);
    raise exception 'Tu viens d''acheter cette ligne. Tu pourras la revendre dans % minute(s).',
      reste_min;
  end if;

  n_jour := public.bourse_ordres_du_jour(moi.id);
  if n_jour >= public.bourse_max_jour() then
    raise exception 'Tu as déjà passé tes % ordres du jour. La bourse rouvre pour toi demain.',
      public.bourse_max_jour();
  end if;

  prix  := public.bourse_cours_actuel(p_code);
  brut  := round(prix * p_nb);
  frais := greatest(1, round(brut * public.bourse_frais()));

  update public.players set gold = gold + brut - frais where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, brut - frais, 'bourse : vente ' || p_nb || ' × ' || p_code);

  if pos.nb = p_nb then
    delete from public.bourse_positions where player_id = moi.id and code = p_code;
  else
    update public.bourse_positions set nb = pos.nb - p_nb
     where player_id = moi.id and code = p_code;
  end if;

  return jsonb_build_object('code', p_code, 'nb', p_nb, 'prix', prix,
                            'brut', brut, 'frais', frais,
                            'gain', round((prix - pos.pru) * p_nb),
                            'or', moi.gold + brut - frais,
                            'ordres', n_jour + 1, 'max', public.bourse_max_jour());
end $$;

revoke all     on function public.bourse_acheter(text, int) from public, anon;
revoke all     on function public.bourse_vendre(text, int)  from public, anon;
grant  execute on function public.bourse_acheter(text, int) to authenticated, service_role;
grant  execute on function public.bourse_vendre(text, int)  to authenticated, service_role;


-- ---------------------------------------------------------------------
--  4. LES AVANTAGES D'ÉQUIPE, AU PRIX DE CE QU'ILS VALENT
--
--  25 LP passait de 80 or le LP à 240. Sur un challenge où l'écart
--  entre le premier et le dernier tourne autour de 200 LP, la boutique
--  ne doit pas pouvoir en fournir autant que le jeu.
--
--  Le double LP est plus cher mais reste le meilleur rapport : il ne
--  rapporte que si l'équipe joue vraiment dans les deux heures, et il
--  profite à tout le monde sauf à son acheteur en particulier. Ce pari
--  mérite un meilleur taux.
--
--  Ces trois prix NE SUIVENT PAS l'indice de la bourse : ce sont des
--  leviers d'équilibre, pas des marchandises.
-- ---------------------------------------------------------------------
create or replace function public.shop_buy_lp(p_lp int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix int := 6000;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if p_lp <> 25 then raise exception 'Le seul lot disponible est de 25 LP'; end if;
  if moi.gold < prix then raise exception 'Il te manque % or', prix - moi.gold; end if;

  update public.players set gold = gold - prix where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -prix, 'achat : 25 LP');

  -- lp = 0 : le classement individuel ne bouge pas.
  -- lp_items = 25 : le total global, lui, les prend.
  insert into public.games (player_id, lp, lp_items, win, duo, kind, match_id, played_on, created_by)
  values (moi.id, 0, 25, true, 'solo', 'shop',
          'shop-' || gen_random_uuid(), current_date, auth.uid());

  return jsonb_build_object('lp', 25, 'prix', prix, 'gold', moi.gold - prix);
end $$;

create or replace function public.shop_buy_boost()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix int := 10000; fin timestamptz; actuel timestamptz;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if moi.gold < prix then raise exception 'Il te manque % or', prix - moi.gold; end if;

  -- On prolonge si l'équipe est déjà sous bonus, on ne l'écrase pas :
  -- deux joueurs qui achètent coup sur coup doivent cumuler, sinon le
  -- second aurait payé pour rien.
  select until into actuel from public.team_boosts where team = moi.team for update;
  fin := greatest(coalesce(actuel, now()), now()) + interval '2 hours';

  update public.players set gold = gold - prix where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -prix, 'achat : double LP pour l''équipe, 2 h');

  insert into public.team_boosts (team, until, bought_by, at)
  values (moi.team, fin, moi.id, now())
  on conflict (team) do update set until = excluded.until,
                                   bought_by = excluded.bought_by, at = now();

  return jsonb_build_object('boost_until', fin, 'team', moi.team,
                            'prix', prix, 'gold', moi.gold - prix);
end $$;

create or replace function public.shop_swap_team()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; autre public.players; prix int := 30000; mon_equipe text;
begin
  select * into moi from public.players where claimed_by = auth.uid() for update;
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if moi.gold < prix then raise exception 'Il te manque % or', prix - moi.gold; end if;

  select * into autre from public.players
   where team <> moi.team and alias_of is null order by random() limit 1 for update;
  if not found then raise exception 'Aucun joueur dans l''équipe adverse'; end if;

  update public.players set gold = gold - prix where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -prix, 'achat : changement d''équipe avec ' || autre.name);

  mon_equipe := moi.team;
  perform set_config('app.team_swap', 'on', true);   -- le temps de l'échange
  update public.players set team = autre.team where id = moi.id;
  update public.players set team = mon_equipe       where id = autre.id;
  perform set_config('app.team_swap', 'off', true);

  return jsonb_build_object('moi', moi.name, 'autre', autre.name,
                            'ma_nouvelle_equipe', autre.team, 'prix', prix);
end $$;

revoke all     on function public.shop_buy_lp(int)    from public, anon;
revoke all     on function public.shop_buy_boost()    from public, anon;
revoke all     on function public.shop_swap_team()    from public, anon;
grant  execute on function public.shop_buy_lp(int)    to authenticated, service_role;
grant  execute on function public.shop_buy_boost()    to authenticated, service_role;
grant  execute on function public.shop_swap_team()    to authenticated, service_role;

notify pgrst, 'reload schema';


-- Les réglages en vigueur, et ce que chacun a déjà fait aujourd'hui.
select public.bourse_frais()     as frais,
       public.bourse_detention() as detention_minimum,
       public.bourse_max_jour()  as ordres_par_jour;

select p.name, p.gold,
       public.bourse_ordres_du_jour(p.id) as ordres_aujourdhui
  from public.players p
 where p.alias_of is null
 order by ordres_aujourdhui desc, p.gold desc;
