-- =====================================================================
--  bataille.sql — l'Ultime Bataille, et la fin de l'achat de LP
--
--  DEUX CHOSES, LE MÊME SOIR.
--
--  1. ON NE VEND PLUS DE LP. Les 25 LP à 6 000 or disparaissent de la
--     boutique, et le Double LP avec eux. À trois jours de la fin, un
--     joueur assis sur sa bourse pouvait acheter l'écart — directement
--     pour les uns, en multipliant ses gains pour l'autre. Les LP se
--     gagnent désormais en jouant, ou se prennent jeudi soir sur la
--     faille.
--
--     Le changement d'équipe reste : il ne crée aucun LP, il déplace
--     des joueurs. Mais il passe de 30 000 à 50 000 or, parce qu'à ce
--     stade retourner une table vaut plus cher qu'au premier jour.
--
--     Un Double LP déjà payé continue de courir jusqu'à son terme :
--     on ferme le robinet, on ne reprend pas ce qui est versé.
--
--  2. L'ULTIME BATAILLE. Jeudi 22 octobre à 21 h, un 5 contre 5. Le
--     camp qui l'emporte GAGNE l'enjeu, celui qui tombe le PERD : le
--     match déplace donc deux fois sa valeur.
--
--     L'enjeu n'est pas un nombre fixe. Il se calcule sur l'écart du
--     moment, et il est taillé pour une chose précise : si le camp en
--     tête perd, il reste devant — mais de peu. Ce « peu » est la
--     marge, réglée dans la table, 150 LP par défaut.
--
--         enjeu = (écart − marge) / 2     gagnant +enjeu, perdant −enjeu
--
--     Avec 1 361 LP d'écart : enjeu ±605, soit 1 210 LP déplacés, et le
--     meneur battu finit à +151. Celui qui chasse joue donc tout son
--     challenge sur ce match sans pouvoir le voler d'un coup, et les
--     deux derniers jours gardent un sens.
--
--     Comme l'écart bouge à chaque partie, l'enjeu est RECALCULÉ au
--     moment où le résultat est saisi. L'annoncer en dur aujourd'hui
--     serait l'annoncer faux jeudi.
--
--     Chacun s'inscrit en choisissant SON POSTE, et un seul joueur par
--     poste et par équipe : le premier inscrit tient le rôle, les
--     suivants passent remplaçants. Celui qui se désiste libère sa
--     place, et le premier remplaçant sur ce poste y monte aussitôt.
--
--     On ne choisit JAMAIS son camp. L'équipe n'est pas un paramètre
--     des fonctions ci-dessous : elle est lue sur la fiche du joueur,
--     côté serveur. Même en appelant l'API à la main, on ne peut pas
--     s'inscrire chez l'adversaire — il n'y a aucun chemin pour le
--     demander.
--
--  Idempotent. À lancer dans le SQL Editor.
-- =====================================================================


-- =====================================================================
--  1. LA BOUTIQUE NE VEND PLUS DE LP
--
--  On garde la fonction au lieu de la supprimer : une page encore
--  ouverte dans un onglet appellerait une fonction disparue et
--  afficherait « 404 », ce qui ressemble à une panne. Là, elle dit
--  pourquoi.
-- =====================================================================
create or replace function public.shop_buy_lp(p_lp int)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Les LP ne sont plus en vente. À partir de maintenant ils se gagnent en jouant — ou jeudi soir, à l''Ultime Bataille.';
end $$;

revoke all     on function public.shop_buy_lp(int) from public, anon;
grant  execute on function public.shop_buy_lp(int) to authenticated, service_role;

-- Même traitement pour le doublement : il ne vend pas des LP, il les
-- multiplie, ce qui revient au même à trois jours de la fin.
create or replace function public.shop_buy_boost()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Le Double LP n''est plus en vente. Les LP se gagnent en jouant — ou jeudi soir, à l''Ultime Bataille.';
end $$;

revoke all     on function public.shop_buy_boost() from public, anon;
grant  execute on function public.shop_buy_boost() to authenticated, service_role;


-- ---------------------------------------------------------------------
--  Le changement d'équipe : 30 000 → 50 000 or
--
--  On ne réécrit pas la fonction, on ne corrige que le prix : elle
--  porte tout le tirage au sort et l'échange, et la retaper en entier
--  pour un nombre serait le meilleur moyen d'y perdre quelque chose.
-- ---------------------------------------------------------------------
do $$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'shop_swap_team';
  if src is null then
    raise notice 'shop_swap_team introuvable : rien à retarifer.';
    return;
  end if;
  if position('prix int := 30000' in src) = 0 then
    raise notice 'Le prix du changement d''équipe n''est pas à 30 000 : rien touché.';
    return;
  end if;
  execute replace(src, 'prix int := 30000', 'prix int := 50000');
  raise notice 'Changement d''équipe : 50 000 or.';
end $$;


-- =====================================================================
--  2. L'ÉVÉNEMENT
-- =====================================================================
create table if not exists public.bataille (
  id     int primary key default 1,
  quand  timestamptz not null,
  lot    int  not null default 1000,
  ouvert boolean not null default true,
  constraint bataille_une_seule check (id = 1)
);

/* Ce que le camp en tête conserve s'il perd la bataille. C'est le seul
   réglage de l'événement : l'enjeu en découle. */
alter table public.bataille add column if not exists marge int not null default 150;

-- Jeudi 22 octobre 2026, 21 h, heure de Paris.
insert into public.bataille (id, quand, lot, ouvert)
values (1, timestamptz '2026-10-22 21:00:00 Europe/Paris', 1000, true)
on conflict (id) do nothing;

-- Les LP de la bataille arrivent sur une ligne de partie d'un genre
-- nouveau, comme les péages et les parts de duo avant eux.
alter table public.games drop constraint if exists games_kind_valid;
do $$ begin
  alter table public.games add constraint games_kind_valid
    check (kind in ('game','adjust','shop','peage','renvoi','partage','bataille'));
exception when duplicate_object then null; end $$;


create table if not exists public.bataille_inscrits (
  player_id  text primary key references public.players(id) on delete cascade,
  -- Recopiée depuis la fiche du joueur, jamais fournie par le client.
  team       text not null check (team in ('a','b')),
  role       text not null check (role in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY')),
  titulaire  boolean not null default true,
  inscrit_le timestamptz not null default now()
);

/* Un seul titulaire par poste et par équipe. L'index partiel fait la
   règle : deux joueurs peuvent viser le même poste, un seul le tient,
   et la base refuserait l'inscription même si la fonction se trompait. */
create unique index if not exists bataille_poste_titulaire
  on public.bataille_inscrits (team, role) where titulaire;

alter table public.bataille          enable row level security;
alter table public.bataille_inscrits enable row level security;

/* Lecture ouverte : la composition des deux camps fait partie du jeu,
   et savoir quel poste est encore libre est le premier renseignement
   qu'on vient chercher.

   AUCUNE policy d'écriture, volontairement : tout passe par les deux
   fonctions plus bas, qui lisent l'équipe sur la fiche du joueur. */
drop policy if exists bataille_read          on public.bataille;
drop policy if exists bataille_inscrits_read on public.bataille_inscrits;
create policy bataille_read          on public.bataille          for select to anon, authenticated using (true);
create policy bataille_inscrits_read on public.bataille_inscrits for select to anon, authenticated using (true);

do $$ begin
  alter publication supabase_realtime add table public.bataille_inscrits;
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
--  Qui suis-je, pour cette bataille
--
--  Un second compte joue pour le joueur qu'il double : on remonte donc
--  à la fiche principale. Sans ça, Tankiste pourrait s'inscrire deux
--  fois, une fois par compte.
-- ---------------------------------------------------------------------
create or replace function public.bataille_moi()
returns public.players language plpgsql stable security definer set search_path = public as $$
declare moi public.players;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if moi.alias_of is not null then
    select * into moi from public.players where id = moi.alias_of;
    if not found then raise exception 'Compte secondaire orphelin : préviens l''administrateur'; end if;
  end if;
  return moi;
end $$;

-- Le créneau est-il encore ouvert aux inscriptions ?
create or replace function public.bataille_verifie()
returns public.bataille language plpgsql stable security definer set search_path = public as $$
declare b public.bataille;
begin
  select * into b from public.bataille where id = 1;
  if not found then raise exception 'Aucune bataille n''est programmée'; end if;
  if not b.ouvert then raise exception 'Les inscriptions sont closes'; end if;
  if now() >= b.quand then raise exception 'La bataille a déjà commencé'; end if;
  return b;
end $$;

/* Le poste laissé vide ne le reste pas : le remplaçant qui l'a demandé
   en premier y monte. Appelée après chaque départ. */
create or replace function public.bataille_promouvoir(p_team text, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare suivant text;
begin
  if exists (select 1 from public.bataille_inscrits
              where team = p_team and role = p_role and titulaire) then
    return;
  end if;
  select player_id into suivant from public.bataille_inscrits
   where team = p_team and role = p_role and not titulaire
   order by inscrit_le limit 1;
  if found then
    update public.bataille_inscrits set titulaire = true where player_id = suivant;
  end if;
end $$;


-- ---------------------------------------------------------------------
--  S'INSCRIRE, ou changer de poste
--
--  p_role est le SEUL paramètre. Pas de joueur, pas d'équipe : on ne
--  peut inscrire que soi, et que dans son camp.
-- ---------------------------------------------------------------------
create or replace function public.bataille_inscrire(p_role text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; b public.bataille;
        avant public.bataille_inscrits; libre boolean;
begin
  b   := public.bataille_verifie();
  moi := public.bataille_moi();

  if p_role is null or p_role not in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY') then
    raise exception 'Choisis un poste : top, jungle, mid, bot ou support';
  end if;

  -- Si je tenais déjà un poste, je le libère AVANT de prendre le
  -- nouveau — sinon changer de rôle buterait sur mon propre verrou.
  select * into avant from public.bataille_inscrits where player_id = moi.id;
  if found then
    if avant.role = p_role then
      return jsonb_build_object('role', p_role, 'titulaire', avant.titulaire,
                                'equipe', moi.team, 'change', false);
    end if;
    delete from public.bataille_inscrits where player_id = moi.id;
    if avant.titulaire then perform public.bataille_promouvoir(avant.team, avant.role); end if;
  end if;

  libre := not exists (select 1 from public.bataille_inscrits
                        where team = moi.team and role = p_role and titulaire);

  insert into public.bataille_inscrits (player_id, team, role, titulaire)
  values (moi.id, moi.team, p_role, libre);

  return jsonb_build_object('role', p_role, 'titulaire', libre,
                            'equipe', moi.team, 'change', true);
end $$;


-- ---------------------------------------------------------------------
--  SE DÉSISTER
-- ---------------------------------------------------------------------
create or replace function public.bataille_desister()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; avant public.bataille_inscrits;
begin
  perform public.bataille_verifie();
  moi := public.bataille_moi();

  select * into avant from public.bataille_inscrits where player_id = moi.id;
  if not found then raise exception 'Tu n''es pas inscrit'; end if;

  delete from public.bataille_inscrits where player_id = moi.id;
  if avant.titulaire then perform public.bataille_promouvoir(avant.team, avant.role); end if;

  return jsonb_build_object('desiste', true, 'role', avant.role);
end $$;

revoke all     on function public.bataille_inscrire(text) from public, anon;
revoke all     on function public.bataille_desister()     from public, anon;
revoke all     on function public.bataille_moi()          from public, anon;
revoke all     on function public.bataille_verifie()      from public, anon;
revoke all     on function public.bataille_promouvoir(text, text) from public, anon;
grant  execute on function public.bataille_inscrire(text) to authenticated, service_role;
grant  execute on function public.bataille_desister()     to authenticated, service_role;

-- ---------------------------------------------------------------------
--  L'ENJEU DU MOMENT
--
--  Lisible par tout le monde : chacun doit pouvoir voir ce qui se joue
--  et ce que chaque issue donnerait. Les parties d'un second compte
--  sont enregistrées sous la fiche principale, donc on écarte les alias
--  pour ne pas compter deux fois.
-- ---------------------------------------------------------------------
create or replace function public.bataille_enjeu()
returns jsonb language sql stable security definer set search_path = public as $$
  with t as (
    select coalesce(sum(case when p.team = 'a' then g.lp + coalesce(g.lp_items, 0) end), 0)::int as a,
           coalesce(sum(case when p.team = 'b' then g.lp + coalesce(g.lp_items, 0) end), 0)::int as b
      from public.players p
      join public.games g on g.player_id = p.id
     where p.alias_of is null
  ), b as (select marge from public.bataille where id = 1)
  select jsonb_build_object(
    'a', t.a, 'b', t.b,
    'ecart',  abs(t.a - t.b),
    'devant', case when t.a >= t.b then 'a' else 'b' end,
    'marge',  b.marge,
    /* Division entière : elle arrondit vers le bas, donc la marge
       réellement conservée est toujours au moins celle annoncée,
       jamais moins. C'est le sens de la garantie. */
    'enjeu',  greatest(0, (abs(t.a - t.b) - b.marge) / 2)
  ) from t, b;
$$;
grant execute on function public.bataille_enjeu() to anon, authenticated;


-- ---------------------------------------------------------------------
--  LE RÉSULTAT
--
--  Réservé à l'administrateur, et rejouable sans dégât : chaque ligne
--  porte un matricule stable et l'index unique (player_id, match_id)
--  refuse le doublon. Saisir deux fois le même vainqueur ne donne donc
--  pas deux fois les LP.
--
--  L'enjeu est partagé entre les CINQ QUI ONT JOUÉ, pas entre tous les
--  inscrits : les remplaçants n'étaient pas sur la faille. Si personne
--  n'est inscrit dans un camp, on retombe sur l'équipe entière.
-- ---------------------------------------------------------------------
create or replace function public.bataille_resoudre(p_gagnant text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  e jsonb; x int; perdant text;
  camp text; signe int; i int;
  joueurs text[]; j text;
  part int; reste int; k int; n int := 0;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if p_gagnant is null or p_gagnant not in ('a','b') then
    raise exception 'Le gagnant est « a » ou « b »';
  end if;

  e := public.bataille_enjeu();
  x := (e->>'enjeu')::int;
  perdant := case p_gagnant when 'a' then 'b' else 'a' end;
  if x <= 0 then
    raise exception 'L''écart est déjà sous la marge : il n''y a rien à déplacer';
  end if;

  /* Deux passes : le camp gagnant encaisse, le perdant règle. Chacun
     partage par parts égales, le reste de la division allant au premier
     inscrit — personne ne s'évapore dans un arrondi. */
  for i in 1..2 loop
    if i = 1 then camp := p_gagnant; signe := 1;
    else           camp := perdant;   signe := -1; end if;

    select array_agg(player_id order by inscrit_le) into joueurs
      from public.bataille_inscrits where team = camp and titulaire;
    if joueurs is null then
      select array_agg(id order by sort) into joueurs
        from public.players where team = camp and alias_of is null;
    end if;
    continue when joueurs is null;

    part  := x / array_length(joueurs, 1);
    reste := x - part * array_length(joueurs, 1);
    k := 0;

    foreach j in array joueurs loop
      k := k + 1;
      insert into public.games (player_id, lp, lp_items, win, duo, kind,
                                match_id, played_on, created_at)
      values (j, 0, signe * (part + case when k = 1 then reste else 0 end),
              signe > 0, 'solo', 'bataille',
              'bataille-' || camp || '-' || j, current_date, now())
      on conflict do nothing;
      n := n + 1;
    end loop;
  end loop;

  -- La bataille a eu lieu : on referme les inscriptions.
  update public.bataille set ouvert = false where id = 1;

  return jsonb_build_object('gagnant', p_gagnant, 'perdant', perdant,
                            'enjeu', x, 'deplace', x * 2, 'lignes', n);
end $$;

revoke all     on function public.bataille_resoudre(text) from public, anon;
grant  execute on function public.bataille_resoudre(text) to authenticated, service_role;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
--  Vérification
-- ---------------------------------------------------------------------
select quand at time zone 'Europe/Paris' as le_soir_dit, marge, ouvert
  from public.bataille where id = 1;

-- L'enjeu tel qu'il serait si la bataille se jouait maintenant.
select public.bataille_enjeu() as enjeu_du_moment;

select i.team, i.role, p.name, i.titulaire, i.inscrit_le
  from public.bataille_inscrits i
  join public.players p on p.id = i.player_id
 order by i.team, i.titulaire desc, i.role;

-- Doivent répondre : ni les LP ni le Double LP ne sont en vente.
do $$ begin
  perform public.shop_buy_lp(25);
  raise warning 'ANOMALIE : la vente de LP répond encore';
exception when others then
  raise notice 'Vente de LP bien fermée (%)', sqlerrm;
end $$;

do $$ begin
  perform public.shop_buy_boost();
  raise warning 'ANOMALIE : le Double LP répond encore';
exception when others then
  raise notice 'Double LP bien fermé (%)', sqlerrm;
end $$;

-- Le prix du changement d'équipe, tel qu'il est désormais écrit.
select case when position('50000' in pg_get_functiondef(p.oid)) > 0
            then '50 000 or' else 'NON RETARIFÉ' end as changement_equipe
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'shop_swap_team';
