-- =====================================================================
--  bourse-v2.sql — vente à découvert, faillites, offres de rachat
--
--  TROIS AJOUTS QUI SE RÉPONDENT
--
--  1. LA VENTE À DÉCOUVERT. Parier à la baisse. On bloque une garantie
--     égale à la valeur vendue ; au rachat on reçoit
--
--         nb × (2 × prix de vente − prix du jour)
--
--     Le cours tombe à rien, on double sa mise. Il double, on ne
--     récupère rien et la position est liquidée d'office. C'est le
--     miroir exact d'un achat, et la garantie dit d'avance ce qu'on
--     risque — sans elle, un découvert pourrait coûter plus que tout
--     l'or qu'on possède, ce qui n'a pas sa place dans un jeu entre
--     copains.
--
--  2. TROIS FAILLITES. Deux spéculatives et une équilibrée tomberont à
--     presque rien avant la fin du challenge. LESQUELLES ET QUAND sont
--     tirées au sort par ce script au moment où tu le lances. Tu avais
--     dit ne pas vouloir être au courant à l'avance : la table n'a
--     aucune policy de lecture (même la clé publique ne voit rien), et
--     la requête de vérification à la fin compte les faillites sans
--     les nommer. Personne ne sait, moi non plus.
--
--  3. LES OFFRES DE RACHAT. Des rumeurs de changement de propriétaire
--     circulent souvent ; la plupart ne mènent à rien. Rarement, l'une
--     devient une offre ferme — et pendant toute l'offre LES FONDS
--     SONT GELÉS sur cette société : plus un seul ordre accepté, et le
--     cours lui-même est suspendu. À la clôture il bondit si l'offre
--     aboutit, s'effondre si le repreneur se désiste.
--
--  Les trois ensemble font un vrai jeu : une rumeur de rachat sur une
--  société qui décline peut annoncer un sauvetage… ou le dernier
--  soubresaut avant la chute. Et celui qui a parié à la baisse peut se
--  retrouver les fonds gelés au pire moment.
--
--  À lancer après equilibrage.sql. Idempotent, SAUF le tirage des
--  faillites : il n'a lieu que si aucune n'est encore programmée.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. LES TABLES
-- ---------------------------------------------------------------------

create table if not exists public.bourse_faillites (
  code        text primary key references public.bourse_societes(code) on delete cascade,
  debut       bigint  not null,
  fin         bigint  not null,
  prix_depart numeric,
  cible       numeric,
  phase       int     not null default 0   -- 0 rien · 1 rumeur · 2 alerte · 3 consommée
);

create table if not exists public.bourse_opa (
  id      bigserial primary key,
  code    text   not null references public.bourse_societes(code) on delete cascade,
  debut   bigint not null,
  fin     bigint not null,
  issue   text check (issue in ('reussie','echouee')),
  resolue boolean not null default false
);
create index if not exists bourse_opa_idx on public.bourse_opa (code, fin desc);

create table if not exists public.bourse_shorts (
  player_id  text not null references public.players(id) on delete cascade,
  code       text not null references public.bourse_societes(code) on delete cascade,
  nb         int     not null check (nb > 0),
  prix_vente numeric not null,
  garantie   int     not null,
  ouvert_le  timestamptz not null default now(),
  primary key (player_id, code)
);

/* Les offres de rachat et les positions à découvert sont PUBLIQUES :
   une offre gèle les fonds de tout le monde, donc tout le monde doit la
   voir, et savoir qui parie contre qui fait partie du sel.

   Les faillites programmées, elles, N'ONT AUCUNE POLICY DE LECTURE.
   C'est volontaire et c'est tout le point : la table existe, le serveur
   s'en sert, et personne — ni la page, ni un joueur curieux muni de la
   clé publique — ne peut l'interroger pour connaître la suite. */
do $$
declare t text;
begin
  foreach t in array array['bourse_faillites','bourse_opa','bourse_shorts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    if t <> 'bourse_faillites' then
      execute format('create policy %I on public.%I for select to anon, authenticated using (true)',
                     t || '_read', t);
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null; end;
    end if;
  end loop;
end $$;


-- ---------------------------------------------------------------------
--  2. OÙ L'ON PEUT ENCORE ÉCHANGER, ET OÙ L'ON NE PEUT PLUS
-- ---------------------------------------------------------------------

-- Une offre de rachat en cours gèle la valeur, dans les deux sens.
create or replace function public.bourse_gelee(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.bourse_opa
                  where code = p_code and not resolue
                    and debut <= public.bourse_slot() and fin > public.bourse_slot());
$$;

/* On ne révèle qu'une faillite DÉJÀ ANNONCÉE au marché (phase 3). Les
   phases 0 à 2 restent invisibles : appeler cette fonction sur les dix
   sociétés ne dit rien de ce qui vient. */
create or replace function public.bourse_failli(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.bourse_faillites
                  where code = p_code and phase >= 3);
$$;

grant execute on function public.bourse_gelee(text)  to anon, authenticated;
grant execute on function public.bourse_failli(text) to anon, authenticated;

-- Le garde-fou commun aux quatre ordres. p_entree distingue ce qui fait
-- prendre un risque (acheter, vendre à découvert) de ce qui le solde.
create or replace function public.bourse_verifie(p_code text, p_joueur text, p_entree boolean)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.bourse_societes where code = p_code and actif) then
    raise exception 'Société inconnue ou retirée de la cote';
  end if;
  if public.bourse_gelee(p_code) then
    raise exception 'Une offre de rachat est en cours sur %. Les fonds sont gelés : aucun ordre n''est accepté tant qu''elle n''est pas close.', p_code;
  end if;
  -- On peut toujours SORTIR d'une société en faillite. Y rester piégé
  -- serait une punition sans leçon.
  if p_entree and public.bourse_failli(p_code) then
    raise exception '% a déposé le bilan. On n''y entre plus.', p_code;
  end if;
  if public.bourse_ordres_du_jour(p_joueur) >= public.bourse_max_jour() then
    raise exception 'Tu as déjà passé tes % ordres du jour. La bourse rouvre pour toi demain.',
      public.bourse_max_jour();
  end if;
end $$;
revoke all on function public.bourse_verifie(text, text, boolean) from public, anon;


-- ---------------------------------------------------------------------
--  3. ACHETER ET VENDRE PASSENT DÉSORMAIS PAR CE GARDE-FOU
--
--  Même logique qu'avant (frais, détention, douze ordres par jour), plus
--  le gel, la faillite, et l'interdiction de tenir les deux sens à la
--  fois sur une même valeur.
-- ---------------------------------------------------------------------
create or replace function public.bourse_acheter(p_code text, p_nb int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix numeric; cout int; frais int;
        pos public.bourse_positions; n_jour int;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if p_nb is null or p_nb < 1 then raise exception 'Quantité invalide'; end if;
  perform public.bourse_verifie(p_code, moi.id, true);

  if exists (select 1 from public.bourse_shorts where player_id = moi.id and code = p_code) then
    raise exception 'Tu es à découvert sur %. Rachète ta position avant de miser à la hausse.', p_code;
  end if;

  n_jour := public.bourse_ordres_du_jour(moi.id);
  prix   := public.bourse_cours_actuel(p_code);
  cout   := round(prix * p_nb);
  frais  := greatest(1, round(cout * public.bourse_frais()));
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
  perform public.bourse_verifie(p_code, moi.id, false);

  n_jour := public.bourse_ordres_du_jour(moi.id);
  prix   := public.bourse_cours_actuel(p_code);
  brut   := round(prix * p_nb);
  frais  := greatest(1, round(brut * public.bourse_frais()));

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


-- ---------------------------------------------------------------------
--  4. LA VENTE À DÉCOUVERT
-- ---------------------------------------------------------------------
create or replace function public.bourse_vendre_decouvert(p_code text, p_nb int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix numeric; garantie int; frais int;
        pos public.bourse_shorts; n_jour int;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if p_nb is null or p_nb < 1 then raise exception 'Quantité invalide'; end if;
  perform public.bourse_verifie(p_code, moi.id, true);

  if exists (select 1 from public.bourse_positions where player_id = moi.id and code = p_code) then
    raise exception 'Tu détiens des parts de %. Solde-les avant de parier contre.', p_code;
  end if;

  n_jour   := public.bourse_ordres_du_jour(moi.id);
  prix     := public.bourse_cours_actuel(p_code);
  garantie := round(prix * p_nb);
  frais    := greatest(1, round(garantie * public.bourse_frais()));
  if moi.gold < garantie + frais then
    raise exception 'Il te manque % or de garantie', garantie + frais - moi.gold;
  end if;

  update public.players set gold = gold - garantie - frais where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -(garantie + frais), 'bourse : découvert ' || p_nb || ' × ' || p_code);

  select * into pos from public.bourse_shorts where player_id = moi.id and code = p_code;
  if found then
    -- Comme pour un achat : renforcer remet la détention à zéro sur
    -- toute la ligne, sinon une part gardée de côté sert de passe-droit.
    update public.bourse_shorts
       set prix_vente = (pos.prix_vente * pos.nb + prix * p_nb) / (pos.nb + p_nb),
           nb = pos.nb + p_nb,
           garantie = pos.garantie + garantie,
           ouvert_le = now()
     where player_id = moi.id and code = p_code;
  else
    insert into public.bourse_shorts (player_id, code, nb, prix_vente, garantie)
    values (moi.id, p_code, p_nb, prix, garantie);
  end if;

  return jsonb_build_object('code', p_code, 'nb', p_nb, 'prix', prix,
                            'garantie', garantie, 'frais', frais,
                            'or', moi.gold - garantie - frais,
                            'liquidation', round((prix * 2)::numeric, 2),
                            'ordres', n_jour + 1, 'max', public.bourse_max_jour());
end $$;

create or replace function public.bourse_racheter(p_code text, p_nb int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix numeric; pos public.bourse_shorts;
        part_gar int; retour int; frais int; n_jour int; reste_min int;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if p_nb is null or p_nb < 1 then raise exception 'Quantité invalide'; end if;

  select * into pos from public.bourse_shorts
   where player_id = moi.id and code = p_code for update;
  if not found or pos.nb < p_nb then raise exception 'Tu n''es pas à découvert sur autant'; end if;

  if pos.ouvert_le + public.bourse_detention() > now() then
    reste_min := ceil(extract(epoch from
      (pos.ouvert_le + public.bourse_detention() - now())) / 60);
    raise exception 'Tu viens d''ouvrir ce découvert. Tu pourras le racheter dans % minute(s).',
      reste_min;
  end if;
  perform public.bourse_verifie(p_code, moi.id, false);

  n_jour   := public.bourse_ordres_du_jour(moi.id);
  prix     := public.bourse_cours_actuel(p_code);
  part_gar := round(pos.garantie::numeric * p_nb / pos.nb);

  /* Le règlement du découvert. La garantie couvrait exactement la
     valeur vendue ; on la rend augmentée de la baisse, diminuée de la
     hausse, et jamais négative — c'est là, et pas plus loin, que
     s'arrête le risque. */
  retour := greatest(0, round(p_nb * (2 * pos.prix_vente - prix)));
  frais  := greatest(1, round(retour * public.bourse_frais()));

  update public.players set gold = gold + retour - frais where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, retour - frais, 'bourse : rachat ' || p_nb || ' × ' || p_code);

  if pos.nb = p_nb then
    delete from public.bourse_shorts where player_id = moi.id and code = p_code;
  else
    update public.bourse_shorts
       set nb = pos.nb - p_nb, garantie = pos.garantie - part_gar
     where player_id = moi.id and code = p_code;
  end if;

  return jsonb_build_object('code', p_code, 'nb', p_nb, 'prix', prix,
                            'prix_vente', round(pos.prix_vente, 2),
                            'garantie', part_gar, 'retour', retour, 'frais', frais,
                            'gain', retour - frais - part_gar,
                            'or', moi.gold + retour - frais,
                            'ordres', n_jour + 1, 'max', public.bourse_max_jour());
end $$;

revoke all     on function public.bourse_acheter(text, int)          from public, anon;
revoke all     on function public.bourse_vendre(text, int)           from public, anon;
revoke all     on function public.bourse_vendre_decouvert(text, int) from public, anon;
revoke all     on function public.bourse_racheter(text, int)         from public, anon;
grant  execute on function public.bourse_acheter(text, int)          to authenticated, service_role;
grant  execute on function public.bourse_vendre(text, int)           to authenticated, service_role;
grant  execute on function public.bourse_vendre_decouvert(text, int) to authenticated, service_role;
grant  execute on function public.bourse_racheter(text, int)         to authenticated, service_role;


-- ---------------------------------------------------------------------
--  5. LA VIE SOUTERRAINE DU MARCHÉ
--
--  Appelée une fois par créneau, avant que les cours soient calculés.
--  Elle fait avancer les faillites, ouvre et clôt les offres de rachat,
--  lâche les rumeurs, et liquide les découverts qui ont mangé leur
--  garantie.
-- ---------------------------------------------------------------------
create or replace function public.bourse_special(p_slot bigint)
returns void language plpgsql security definer set search_path = public as $$
declare f record; o record; sh record; s record;
        p numeric; avance numeric; saut numeric;
begin
  -- ---- les faillites en cours ----------------------------------
  for f in select * from public.bourse_faillites
            where phase < 3 and p_slot >= debut loop

    if f.prix_depart is null then
      f.prix_depart := public.bourse_cours_actuel(f.code);
      update public.bourse_faillites set prix_depart = f.prix_depart where code = f.code;
    end if;

    avance := least(1.0, greatest(0.0,
      (p_slot - f.debut)::numeric / greatest(1, f.fin - f.debut)));

    /* La forme de la chute compte autant que la chute elle-même.
       1 − avance^2,4 ne perd presque rien au début puis tout à la fin :

           quart du chemin   − 4 %   (première rumeur, on peut l'ignorer)
           moitié            −19 %
           trois cinquièmes  −29 %   (alerte : il reste du temps pour agir)
           quatre cinquièmes −59 %
           dix-neuf vingtièmes −88 %
           la fin            le titre ne vaut plus rien

       C'est ce qui laisse les dépêches servir à quelque chose. Avec la
       forme inverse — power(1 − avance, 2,4) — la première rumeur
       tombait sur un titre déjà à moitié prix : trop tard pour en faire
       quoi que ce soit, et vingt pour cent du déclin passés à plat sur
       le plancher. */
    update public.bourse_faillites
       set cible = greatest(1, f.prix_depart * (1 - power(avance, 2.4)))
     where code = f.code;

    select * into s from public.bourse_societes where code = f.code;

    if f.phase = 0 and avance > 0.25 then
      update public.bourse_faillites set phase = 1 where code = f.code;
      insert into public.bourse_depeches (genre, majeur, code, titre, texte)
      values ('baisse', false, f.code, s.nom || ' inquiète ses créanciers',
              'Des retards de paiement circulent. La direction dément fermement.');
    elsif f.phase = 1 and avance > 0.6 then
      update public.bourse_faillites set phase = 2 where code = f.code;
      insert into public.bourse_depeches (genre, majeur, code, titre, texte)
      values ('baisse', true, f.code, s.nom || ' cherche un repreneur en urgence',
              'La société reconnaît ne plus pouvoir honorer ses échéances seule. '
              || 'Sans repreneur, le dépôt de bilan est une question de jours.');
    elsif f.phase = 2 and avance >= 1 then
      update public.bourse_faillites set phase = 3 where code = f.code;
      insert into public.bourse_depeches (genre, majeur, code, titre, texte)
      values ('baisse', true, f.code, s.nom || ' dépose le bilan',
              'Aucun repreneur ne s''est présenté. Le titre ne vaut plus rien et sort '
              || 'des achats. Ceux qui en détiennent peuvent encore solder, pour ce '
              || 'que ça vaut.');
    end if;
  end loop;

  -- ---- les offres de rachat qui arrivent à terme ----------------
  for o in select * from public.bourse_opa where not resolue and fin <= p_slot loop
    select * into s from public.bourse_societes where code = o.code;
    p := public.bourse_cours_actuel(o.code);

    if random() < 0.6 then
      saut := 1 + 0.25 + random() * 0.35;
      update public.bourse_opa set resolue = true, issue = 'reussie' where id = o.id;
      insert into public.bourse_depeches (genre, majeur, code, titre, texte)
      values ('hausse', true, o.code, 'Rachat de ' || s.nom || ' : offre acceptée',
              'L''opération se fait. Le titre est revalorisé et les échanges reprennent.');
    else
      saut := 1 - (0.15 + random() * 0.15);
      update public.bourse_opa set resolue = true, issue = 'echouee' where id = o.id;
      insert into public.bourse_depeches (genre, majeur, code, titre, texte)
      values ('baisse', true, o.code, 'Rachat de ' || s.nom || ' : offre retirée',
              'Le repreneur s''est désisté. Le titre retombe, et les échanges reprennent.');
    end if;

    /* Le saut est posé directement dans le relevé : une offre se dénoue
       d'un coup, pas en pente douce. Le relevé qui suit insère avec
       « do nothing » et ne l'écrasera donc pas. */
    insert into public.bourse_cours (code, slot, at, o, h, b, c)
    values (o.code, p_slot, to_timestamp(p_slot * 300),
            round(p::numeric, 2),
            round((greatest(p, p * saut) * 1.01)::numeric, 2),
            round((least(p, p * saut) * 0.99)::numeric, 2),
            round((p * saut)::numeric, 2))
    on conflict (code, slot) do update
      set o = excluded.o, h = excluded.h, b = excluded.b, c = excluded.c;
  end loop;

  -- ---- une nouvelle offre, rarement ------------------------------
  --  0,12 % par créneau, et jamais deux à la fois : environ une tous
  --  les trois jours.
  if random() < 0.0012
     and not exists (select 1 from public.bourse_opa where not resolue) then
    select sc.* into s from public.bourse_societes sc
     where sc.actif
       and not exists (select 1 from public.bourse_faillites bf
                        where bf.code = sc.code and bf.phase >= 3)
     order by random() limit 1;
    if found then
      -- Deux à six heures de gel.
      insert into public.bourse_opa (code, debut, fin)
      values (s.code, p_slot, p_slot + 24 + floor(random() * 48)::int);
      insert into public.bourse_depeches (genre, majeur, code, titre, texte)
      values ('info', true, s.code, 'Offre de rachat sur ' || s.nom,
              'Un repreneur a déposé une offre ferme. Les échanges sur ' || s.code
              || ' sont SUSPENDUS jusqu''à la clôture : les fonds engagés dessus '
              || 'sont gelés, et le cours ne bouge plus.');
    end if;
  end if;

  -- ---- les rumeurs, bien plus souvent ----------------------------
  --  1,2 % par créneau : trois ou quatre par jour. La plupart ne mènent
  --  nulle part, et c'est exactement le but — sinon la vraie offre se
  --  verrait arriver de loin.
  if random() < 0.012 then
    select sc.* into s from public.bourse_societes sc where sc.actif order by random() limit 1;
    insert into public.bourse_depeches (genre, majeur, code, titre, texte)
    values (case when random() < 0.5 then 'hausse' else 'info' end, false, s.code,
            s.nom || ' : des bruits de couloir',
            (array[
              'On prête à un concurrent l''intention d''en prendre le contrôle.',
              'Un fonds étranger aurait pris une participation discrète au capital.',
              'La famille fondatrice envisagerait de céder ses parts.',
              'Des banquiers d''affaires ont été vus au siège. La direction ne commente pas.',
              'Le conseil se réunirait en urgence sur un projet de cession.'
            ])[1 + floor(random() * 5)::int]
            || ' Rien n''est confirmé.');
  end if;

  -- ---- les découverts qui ont mangé leur garantie ----------------
  for sh in select * from public.bourse_shorts loop
    if public.bourse_cours_actuel(sh.code) >= sh.prix_vente * 2 then
      delete from public.bourse_shorts
       where player_id = sh.player_id and code = sh.code;
      /* Le libellé ne commence VOLONTAIREMENT pas par « bourse : » :
         bourse_ordres_du_jour() compte ce préfixe, et une liquidation
         subie ne doit pas coûter un ordre au joueur. */
      insert into public.gold_ledger (player_id, delta, raison)
      values (sh.player_id, 0, 'Découvert liquidé d''office sur ' || sh.code
              || ' (garantie de ' || sh.garantie || ' or perdue)');
      insert into public.bourse_depeches (genre, majeur, code, titre, texte)
      values ('hausse', false, sh.code, 'Liquidation d''un découvert sur ' || sh.code,
              'Le cours a doublé depuis la vente : une garantie a été entièrement consommée.');
    end if;
  end loop;
end $$;

revoke all     on function public.bourse_special(bigint) from public, anon;
grant  execute on function public.bourse_special(bigint) to service_role;


-- ---------------------------------------------------------------------
--  6. QUATRE GREFFES DANS LE RELEVÉ
--
--  Plutôt que réécrire les cent cinquante lignes de bourse_tick — et
--  risquer de perdre au passage un correctif durement acquis — on relit
--  sa définition et on y pose exactement ce qu'il manque :
--
--    a. une variable de travail ;
--    b. l'appel à bourse_special, une fois par créneau ;
--    c. le cours forcé des sociétés qui coulent, et le gel pendant une
--       offre de rachat ;
--    d. un plancher de mèche basse qui ne dépasse plus la clôture —
--       sans ça, un titre tombé à 1 aurait un plus-bas à 2 et la
--       bougie serait absurde.
-- ---------------------------------------------------------------------
do $$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'bourse_tick';

  if src is null then
    raise exception 'bourse_tick est introuvable : lance bourse.sql d''abord';
  end if;

  if position('bourse_special' in src) > 0 then
    raise notice 'bourse_tick est déjà greffé.';
    return;
  end if;

  src := replace(src,
    '  forme_du_tick numeric;',
    '  forme_du_tick numeric;' || chr(10) || '  cible_chute numeric;');

  src := replace(src,
    'humeur := (random() - 0.5) * 0.014;',
    'humeur := (random() - 0.5) * 0.014;' || chr(10) || chr(10) ||
    '    -- Faillites, offres de rachat, rumeurs, liquidations : tout ce' || chr(10) ||
    '    -- qui arrive au marche sans qu''un joueur l''ait demande.' || chr(10) ||
    '    perform public.bourse_special(s);');

  src := replace(src,
    'clo := greatest(soc.prix_base / 6, least(soc.prix_base * 6, clo));',
    'clo := greatest(soc.prix_base / 6, least(soc.prix_base * 6, clo));' || chr(10) || chr(10) ||
    '      -- Une societe qui coule ignore le plancher du sixieme : c''est' || chr(10) ||
    '      -- tout l''interet de la chose. Et pendant une offre de rachat' || chr(10) ||
    '      -- le cours est suspendu, comme les ordres.' || chr(10) ||
    '      select bf.cible into cible_chute from public.bourse_faillites bf' || chr(10) ||
    '       where bf.code = soc.code and bf.cible is not null;' || chr(10) ||
    '      if found then' || chr(10) ||
    '        clo := greatest(1, cible_chute * (0.97 + random() * 0.06));' || chr(10) ||
    '      elsif public.bourse_gelee(soc.code) then' || chr(10) ||
    '        clo := ouv;' || chr(10) ||
    '      end if;');

  src := replace(src,
    'round((greatest(2, least(ouv, clo) - amp * random() * 0.6))::numeric, 2),',
    'round((greatest(least(2, clo), least(ouv, clo) - amp * random() * 0.6))::numeric, 2),');

  if position('bourse_special' in src) = 0 or position('cible_chute' in src) = 0 then
    raise exception 'Les greffes n''ont pas pris : bourse_tick a change de forme';
  end if;

  execute src;
  raise notice 'bourse_tick greffe.';
end $$;


-- ---------------------------------------------------------------------
--  7. LE TIRAGE DES TROIS CONDAMNÉES
--
--  Deux spéculatives et une équilibrée, au hasard, avec un déclin de un
--  à trois jours qui se referme au moins six heures avant le terme du
--  challenge.
--
--  CE BLOC NE S'EXÉCUTE QU'UNE FOIS, et rien nulle part n'affichera
--  lesquelles.
-- ---------------------------------------------------------------------
do $$
declare
  maintenant bigint := public.bourse_slot();
  terme      bigint;
  espace     bigint;
  ch         record;
  condamnees text[];
  c          text;
  d          bigint;
  duree      int;
begin
  if exists (select 1 from public.bourse_faillites) then
    raise notice 'Des faillites sont deja programmees : rien a tirer.';
    return;
  end if;

  select start_date, days into ch from public.challenge where id = 1;
  terme := floor(extract(epoch from
    ((ch.start_date + ch.days * interval '1 day') at time zone 'Europe/Paris')) / 300)::bigint;

  -- 72 créneaux = six heures de marge avant le terme ; 12 = une heure
  -- avant que quoi que ce soit puisse commencer.
  espace := terme - 72 - (maintenant + 12);
  if espace < 432 then
    raise notice 'Trop pres du terme (% creneaux) : aucune faillite programmee.', espace;
    return;
  end if;

  /* Deux tirages séparés, concaténés. array(sous-requête) accepte un
     order by et un limit à l'intérieur, là où un union all dans un for
     plpgsql demande de deviner comment l'analyseur découpe la requête.
     Ici il n'y a rien à deviner. */
  condamnees :=
    array(select code from public.bourse_societes
           where actif and risque = 'speculative' order by random() limit 2)
    ||
    array(select code from public.bourse_societes
           where actif and risque = 'equilibree'  order by random() limit 1);

  if array_length(condamnees, 1) is distinct from 3 then
    raise notice 'La cote ne contient pas deux speculatives et une equilibree : % tiree(s).',
      coalesce(array_length(condamnees, 1), 0);
  end if;

  foreach c in array condamnees loop
    duree := least(288 + floor(random() * 576)::int, greatest(144, (espace / 2)::int));
    d     := maintenant + 12 + floor(random() * greatest(1, espace - duree))::bigint;
    insert into public.bourse_faillites (code, debut, fin)
    values (c, d, d + duree)
    on conflict (code) do nothing;
  end loop;

  raise notice 'Trois faillites programmees. Ni ce script ni personne ne dira lesquelles.';
end $$;

-- ---------------------------------------------------------------------
--  8. CE QUE LA PAGE A LE DROIT DE SAVOIR
--
--  Une vue plutôt que dix appels : la page a besoin, pour chaque
--  société, de savoir si elle est gelée et si le bilan est déposé.
--
--  Une vue ordinaire s'exécute avec les droits de son propriétaire et
--  ne passe donc pas par la RLS de bourse_faillites — c'est ce qui
--  permet de répondre « oui, celle-là a coulé » sans jamais ouvrir la
--  table. Elle ne reflète que la phase 3, c'est-à-dire ce que les
--  dépêches ont déjà annoncé à tout le monde. Ce qui vient reste caché.
-- ---------------------------------------------------------------------
/* Trois sociétés à 1 au lieu de 150, c'est trente pour cent d'indice en
   moins — et comme le Commerce indexe ses prix dessus, un légendaire
   finirait le challenge à moitié prix de façon permanente. Ce n'est pas
   un marché en berne, c'est une moyenne qui traîne des cadavres.

   Un titre radié quitte son indice, dans la vraie vie comme ici. Le
   DÉCLIN, lui, compte toujours : tant que la société est cotée, sa
   chute pèse sur l'indice et met les rayons en solde, ce qui est
   exactement l'effet voulu. C'est seulement une fois le bilan déposé —
   le titre ne vaut plus rien et sort des achats — qu'elle cesse de
   peser. */
create or replace function public.bourse_indice()
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(round(avg(public.bourse_cours_actuel(s.code) / s.prix_base) * 1000, 1), 1000)
    from public.bourse_societes s
   where s.actif
     and not exists (select 1 from public.bourse_faillites bf
                      where bf.code = s.code and bf.phase >= 3);
$$;
grant execute on function public.bourse_indice() to anon, authenticated;


create or replace view public.bourse_etats as
select s.code,
       public.bourse_gelee(s.code)  as gelee,
       public.bourse_failli(s.code) as failli,
       (select o.fin from public.bourse_opa o
         where o.code = s.code and not o.resolue
         order by o.fin desc limit 1) as opa_fin
  from public.bourse_societes s
 where s.actif;

grant select on public.bourse_etats to anon, authenticated;


notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
--  Vérification. Volontairement muette sur les faillites : on confirme
--  qu'il y en a bien trois, pas lesquelles.
-- ---------------------------------------------------------------------
select count(*) as faillites_programmees from public.bourse_faillites;

select public.bourse_frais() as frais, public.bourse_detention() as detention,
       public.bourse_max_jour() as ordres_par_jour;

select s.code, s.nom, s.risque, coalesce(s.lien, '—') as equipe,
       round(public.bourse_cours_actuel(s.code), 1) as cours,
       public.bourse_gelee(s.code)  as echanges_geles,
       public.bourse_failli(s.code) as bilan_depose
  from public.bourse_societes s where s.actif order by s.sort;
