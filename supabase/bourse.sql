-- =====================================================================
--  bourse.sql — la Place de Runeterra
--
--  Dix sociétés cotées. On y investit son or du challenge, celui qui
--  achète aussi les objets et les LP : perdre en bourse coûte donc
--  vraiment quelque chose.
--
--  CE QUI FAIT BOUGER UN COURS, à chaque relevé de cinq minutes :
--    · la forme de l'équipe à laquelle la société est liée (les LP
--      relevés chez Riot dans l'heure) — la part « joueurs » ;
--    · l'humeur du marché, tirée au sort, commune à tous — la part
--      « non joueurs » ;
--    · sa propre tendance, poussée par les opérations du jour ;
--    · un bruit de fond ;
--    · et, de loin en loin, une secousse.
--
--  Le tout multiplié par le NIVEAU DE RISQUE de la société. C'est lui
--  qui fait qu'une prudente encaisse un krach et qu'une spéculative le
--  prend de plein fouet.
--
--  PERSONNE NE DÉCLENCHE RIEN. Les opérations tombent une fois sur
--  quatre, les secousses majeures une fois sur deux mille, avec un
--  repos de vingt-quatre heures entre deux. Ni l'administrateur ni
--  personne ne sait quand.
--
--  LE COMMERCE SUIT. Les prix des objets sont indexés sur l'indice :
--  il monte, tout coûte plus cher ; il s'effondre, les rayons passent
--  en solde. Plus un objet est rare, plus il est cyclique.
--
--  À lancer après objets-v2.sql. Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. LES TABLES
-- ---------------------------------------------------------------------

create table if not exists public.bourse_societes (
  code      text primary key,
  nom       text not null,
  secteur   text not null,
  risque    text not null check (risque in ('prudente','equilibree','speculative')),
  lien      text check (lien in ('a','b')),        -- null = indépendante du challenge
  prix_base numeric not null check (prix_base > 0),
  derive    numeric not null default 0,            -- tendance courante
  actif     boolean not null default true,
  sort      int     not null default 0
);

-- Une bougie par société et par créneau de cinq minutes.
create table if not exists public.bourse_cours (
  code text   not null references public.bourse_societes(code) on delete cascade,
  slot bigint not null,
  at   timestamptz not null default now(),
  o numeric not null, h numeric not null, b numeric not null, c numeric not null,
  primary key (code, slot)
);
create index if not exists bourse_cours_idx on public.bourse_cours (code, slot desc);

-- L'état du marché : une seule ligne.
create table if not exists public.bourse_etat (
  id              int primary key default 1 check (id = 1),
  slot            bigint  not null default 0,
  indice_ref      numeric,
  secousse_genre  text,
  secousse_force  numeric,
  secousse_cible  text,        -- 'tout', un secteur, ou 'prudente' pour la fuite vers la qualité
  secousse_reste  int not null default 0,
  repos           int not null default 0,
  ouvert          boolean not null default true
);
insert into public.bourse_etat (id) values (1) on conflict (id) do nothing;

create table if not exists public.bourse_positions (
  player_id text not null references public.players(id) on delete cascade,
  code      text not null references public.bourse_societes(code) on delete cascade,
  nb        int     not null check (nb >= 0),
  pru       numeric not null,
  primary key (player_id, code)
);

create table if not exists public.bourse_depeches (
  id     bigserial primary key,
  at     timestamptz not null default now(),
  genre  text not null check (genre in ('hausse','baisse','info')),
  majeur boolean not null default false,
  code   text,
  titre  text not null,
  texte  text not null
);
create index if not exists bourse_depeches_idx on public.bourse_depeches (at desc);


-- ---------------------------------------------------------------------
--  2. LECTURE PUBLIQUE, ÉCRITURE RÉSERVÉE
--     Tout le monde voit les cours et les positions des autres : une
--     bourse où l'on ne verrait pas qui détient quoi n'aurait aucun
--     intérêt. Rien ne s'écrit depuis le navigateur, seulement par les
--     fonctions plus bas.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['bourse_societes','bourse_cours','bourse_etat',
                           'bourse_positions','bourse_depeches'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)',
                   t || '_read', t);
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;


-- ---------------------------------------------------------------------
--  3. LE CATALOGUE
-- ---------------------------------------------------------------------
insert into public.bourse_societes (code, nom, secteur, risque, lien, prix_base, sort) values
  ('PLT','Piltover Tech',       'Technologie',     'speculative', 'a', 184, 1),
  ('ZAU','Zaun Chimie',         'Chimie',          'speculative', null, 96, 2),
  ('DEM','Demacia Acier',       'Industrie',       'prudente',    'a', 212, 3),
  ('NOX','Noxus Armement',      'Armement',        'equilibree',  'b', 158, 4),
  ('ION','Ionia Jardins',       'Agroalimentaire', 'prudente',    null,134, 5),
  ('FRE','Freljord Énergie',    'Énergie',         'equilibree',  'b', 121, 6),
  ('BIL','Bilgewater Fret',     'Transport',       'speculative', null, 78, 7),
  ('SHU','Shurima Mines',       'Minier',          'equilibree',  'a', 167, 8),
  ('TRG','Targon Observatoire', 'Recherche',       'prudente',    null,243, 9),
  ('IXT','Ixtal Botanique',     'Pharmacie',       'equilibree',  'b', 109,10)
on conflict (code) do update set
  nom = excluded.nom, secteur = excluded.secteur, risque = excluded.risque,
  lien = excluded.lien, sort = excluded.sort;


-- ---------------------------------------------------------------------
--  4. LES OUTILS
-- ---------------------------------------------------------------------

-- Le risque multiplie toute la volatilité, secousses comprises.
create or replace function public.bourse_vol(p_risque text)
returns numeric language sql immutable as $$
  select case p_risque when 'prudente' then 0.40
                       when 'speculative' then 2.20 else 1.00 end;
$$;

-- Le créneau de cinq minutes dans lequel tombe un instant.
create or replace function public.bourse_slot(p_quand timestamptz default now())
returns bigint language sql stable as $$
  select floor(extract(epoch from p_quand) / 300)::bigint;
$$;

-- Le dernier cours connu d'une société, son prix de base si elle n'a
-- jamais coté.
create or replace function public.bourse_cours_actuel(p_code text)
returns numeric language sql stable as $$
  select coalesce(
    (select c from public.bourse_cours where code = p_code order by slot desc limit 1),
    (select prix_base from public.bourse_societes where code = p_code));
$$;

/* L'indice : la moyenne des cours rapportée aux prix de base, en base
   1 000. Un indice à 1 000 veut dire « le marché est à son point de
   départ » ; c'est lui qui pilote les prix du Commerce. */
create or replace function public.bourse_indice()
returns numeric language sql stable as $$
  select coalesce(round(avg(public.bourse_cours_actuel(s.code) / s.prix_base) * 1000, 1), 1000)
    from public.bourse_societes s where s.actif;
$$;

/* Le prix d'un objet, indexé sur l'indice.

   La sensibilité dépend de la rareté : un commun est une denrée de
   base, un légendaire un produit de luxe, et le luxe suit les humeurs
   du marché bien plus fort. Borné des deux côtés — même un krach
   historique ne brade pas tout, et une bulle ne rend pas la boutique
   inaccessible. Arrondi à cinq, un prix au pour-cent serait illisible. */
create or replace function public.prix_indexe(p_base numeric, p_rarete text)
returns int language sql stable as $$
  select greatest(5, round(p_base * greatest(0.55, least(1.60,
    1 + (public.bourse_indice() / 1000 - 1) *
        case p_rarete when 'commun' then 0.6
                      when 'coffre' then 0.8
                      when 'legendaire' then 1.5
                      else 1.0 end)) / 5) * 5)::int;
$$;

-- Le prix courant d'un objet du catalogue.
create or replace function public.prix_objet(p_item text)
returns int language sql stable as $$
  select public.prix_indexe(i.price, i.rarity) from public.items i where i.key = p_item;
$$;


-- ---------------------------------------------------------------------
--  5. LE RELEVÉ DES COURS
--
--  Appelé toutes les cinq minutes. Idempotent par créneau : deux appels
--  dans la même tranche de cinq minutes ne produisent qu'une bougie.
--  S'il a manqué des créneaux (fonction en panne, projet en pause), il
--  les rattrape, dans la limite de p_max pour ne pas bloquer une heure.
-- ---------------------------------------------------------------------
create or replace function public.bourse_tick(p_max int default 24)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  etat        public.bourse_etat;
  viser       bigint;
  s           bigint;
  faits       int := 0;
  humeur      numeric;
  forme_a     numeric;
  forme_b     numeric;
  soc         record;
  ouv numeric; clo numeric; amp numeric; rend numeric; choc numeric;
  n_dep       int := 0;
  n_maj       int := 0;
  op          record;
  maj         record;
begin
  select * into etat from public.bourse_etat where id = 1 for update;
  if not etat.ouvert then return jsonb_build_object('ferme', true); end if;

  viser := public.bourse_slot();
  if etat.slot = 0 then etat.slot := viser - 1; end if;      -- première fois
  if viser <= etat.slot then
    return jsonb_build_object('bougies', 0, 'indice', public.bourse_indice());
  end if;
  if viser - etat.slot > p_max then etat.slot := viser - p_max; end if;

  /* La forme d'une équipe : ce qu'elle a pris ou perdu en LP dans
     l'heure, ramené à une échelle utilisable. Bornée, sinon une soirée
     exceptionnelle enverrait les cours dans la stratosphère. */
  select greatest(-0.02, least(0.02, coalesce(sum(g.lp), 0) / 600.0))
    into forme_a
    from public.games g join public.players p on p.id = g.player_id
   where p.team = 'a' and g.kind = 'game' and g.created_at > now() - interval '1 hour';
  select greatest(-0.02, least(0.02, coalesce(sum(g.lp), 0) / 600.0))
    into forme_b
    from public.games g join public.players p on p.id = g.player_id
   where p.team = 'b' and g.kind = 'game' and g.created_at > now() - interval '1 hour';

  s := etat.slot;
  while s < viser and faits < p_max loop
    s := s + 1;
    faits := faits + 1;
    humeur := (random() - 0.5) * 0.014;

    for soc in select * from public.bourse_societes where actif order by sort loop
      ouv := public.bourse_cours_actuel(soc.code);

      choc := 0;
      if etat.secousse_reste > 0 then
        choc := case
          when etat.secousse_cible = 'tout' then etat.secousse_force
          when etat.secousse_cible = 'prudente' then
               case when soc.risque = 'prudente' then abs(etat.secousse_force) * 0.25
                    else etat.secousse_force end
          when etat.secousse_cible = soc.secteur then etat.secousse_force
          else etat.secousse_force * 0.12
        end * public.bourse_vol(soc.risque) * (0.6 + random() * 0.8);
      end if;

      rend := (coalesce(case soc.lien when 'a' then forme_a when 'b' then forme_b end, 0) * 0.9
               + humeur
               + (random() - 0.5) * 0.026
               + soc.derive) * public.bourse_vol(soc.risque)
              + choc;

      clo := greatest(4, ouv * (1 + rend));
      amp := abs(ouv - clo) + ouv * (0.002 + random() * 0.009) * public.bourse_vol(soc.risque);

      insert into public.bourse_cours (code, slot, at, o, h, b, c)
      /* Les casts ne sont pas de la decoration : random() rend du
         double precision, qui contamine toute l'expression, et
         round(x, n) n'existe que pour numeric. Sans eux, Postgres
         repond « function round(double precision, integer) does not
         exist ». */
      values (soc.code, s, to_timestamp(s * 300),
              round(ouv::numeric, 2),
              round((greatest(ouv, clo) + amp * random() * 0.6)::numeric, 2),
              round((greatest(2, least(ouv, clo) - amp * random() * 0.6))::numeric, 2),
              round(clo::numeric, 2))
      on conflict (code, slot) do nothing;

      -- Une tendance s'épuise vite, et reste bornée : sans plafond,
      -- deux bonnes nouvelles d'affilée lancent une valeur dans une
      -- spirale dont elle ne redescend plus.
      update public.bourse_societes
         set derive = greatest(-0.03, least(0.03, derive * 0.74))
       where code = soc.code;
    end loop;

    if etat.secousse_reste > 0 then
      etat.secousse_reste := etat.secousse_reste - 1;
      if etat.secousse_reste = 0 then
        etat.repos := 288;                       -- vingt-quatre heures d'accalmie
        insert into public.bourse_depeches (genre, majeur, titre, texte)
        values ('info', false, 'Le marché se stabilise',
                'Les cours reprennent leur rythme ordinaire.');
        n_dep := n_dep + 1;
      end if;
    elsif etat.repos > 0 then
      etat.repos := etat.repos - 1;
    end if;

    -- Les opérations ordinaires : une fois sur quatre, il se passe
    -- quelque chose quelque part.
    if random() < 0.25 then
      select * into op from (values
        (1,'décroche un contrat',          'Le carnet de commandes se remplit pour le trimestre.'),
        (1,'publie de bons résultats',     'Les marges dépassent ce que le marché attendait.'),
        (1,'ouvre une nouvelle usine',     'La production doit doubler d''ici la fin du challenge.'),
        (1,'rachète un concurrent',        'L''opération est financée sans dette nouvelle.'),
        (1,'signe à l''export',            'Un débouché s''ouvre loin de ses bases.'),
        (1,'dévoile un brevet',            'La concurrence aura du mal à suivre.'),
        (0,'rappelle un lot défectueux',   'La direction parle d''un incident isolé. Le marché doute.'),
        (0,'perd un marché important',     'Le concurrent a cassé les prix. La note est salée.'),
        (0,'voit son directeur démissionner','Aucun remplaçant n''est annoncé.'),
        (0,'reporte ses livraisons',       'Un fournisseur fait défaut, la chaîne est à l''arrêt.'),
        (0,'est visée par une enquête',    'Les autorités s''intéressent à ses comptes.'),
        (0,'révise ses prévisions',        'Le trimestre sera moins bon qu''annoncé.')
      ) as t(sens, titre, texte) order by random() limit 1;

      select * into soc from public.bourse_societes where actif order by random() limit 1;

      update public.bourse_societes
         set derive = greatest(-0.03, least(0.03,
               derive + case when op.sens = 1 then 1 else -1 end
                        * (0.005 + random() * 0.013) * public.bourse_vol(risque)))
       where code = soc.code;

      insert into public.bourse_depeches (genre, majeur, code, titre, texte)
      values (case when op.sens = 1 then 'hausse' else 'baisse' end, false, soc.code,
              soc.nom || ' ' || op.titre,
              op.texte || ' ' || soc.code || case when op.sens = 1 then ' monte.' else ' recule.' end);
      n_dep := n_dep + 1;
    end if;

    /* Les secousses majeures : une chance sur deux mille par relevé,
       jamais deux dans la même journée. Sur trois semaines, cela fait
       deux ou trois renversements, à des moments que personne ne
       connaît d'avance. */
    if etat.secousse_reste = 0 and etat.repos = 0 and random() < 0.0005 then
      select * into maj from (values
        ('baisse','tout',       -0.055, 9, 'Krach sur la Place',
         'Les ventes s''enchaînent sur toutes les valeurs. Les spéculatives dévissent deux fois plus vite.'),
        ('hausse','tout',        0.045, 7, 'Euphorie générale',
         'L''indice s''envole. Personne ne sait vraiment dire pourquoi, et tout le monde achète.'),
        ('baisse','Énergie',    -0.060, 8, 'Crise de l''énergie',
         'L''industrie et les transports encaissent. Les valeurs de recherche résistent.'),
        ('hausse','Technologie', 0.075, 7, 'Ruée sur la technologie',
         'Les capitaux se déversent sur la tech. Le reste stagne.'),
        ('baisse','prudente',   -0.050, 8, 'Défaut d''un grand créancier',
         'La défiance gagne les sociétés risquées. Les prudentes servent de refuge.'),
        ('baisse','Transport',  -0.058, 7, 'Blocage des routes commerciales',
         'Le fret est à l''arrêt. Les marchandises n''arrivent plus.')
      ) as t(genre, cible, force, duree, titre, texte) order by random() limit 1;

      etat.secousse_genre := maj.genre;
      etat.secousse_cible := maj.cible;
      etat.secousse_force := maj.force;
      etat.secousse_reste := maj.duree;

      insert into public.bourse_depeches (genre, majeur, titre, texte)
      values (maj.genre, true, maj.titre, maj.texte);
      n_dep := n_dep + 1;
      n_maj := n_maj + 1;
    end if;
  end loop;

  if etat.indice_ref is null then etat.indice_ref := 1000; end if;

  update public.bourse_etat
     set slot = s, indice_ref = etat.indice_ref,
         secousse_genre = etat.secousse_genre, secousse_cible = etat.secousse_cible,
         secousse_force = etat.secousse_force, secousse_reste = etat.secousse_reste,
         repos = etat.repos
   where id = 1;

  -- On ne garde pas l'histoire complète : deux mille bougies par
  -- société suffisent largement à tous les graphiques du site.
  delete from public.bourse_cours where slot < s - 2000;
  delete from public.bourse_depeches
   where id in (select id from public.bourse_depeches order by at desc offset 200);

  return jsonb_build_object('bougies', faits, 'depeches', n_dep, 'secousses', n_maj,
                            'indice', public.bourse_indice(), 'slot', s);
end $$;

revoke all     on function public.bourse_tick(int) from public, anon;
grant  execute on function public.bourse_tick(int) to authenticated, service_role;


-- ---------------------------------------------------------------------
--  6. ACHETER, VENDRE
--
--  1 % de frais de chaque côté. Assez bas pour qu'on ose entrer, assez
--  haut pour que l'aller-retour permanent ne rapporte rien — à 2 % le
--  tour, il faut viser plus que le bruit du marché. C'est aussi un
--  robinet qui retire un peu d'or du challenge à chaque ordre.
--
--  Le prix facturé est TOUJOURS celui lu ici, jamais celui affiché à
--  l'écran : entre le clic et l'exécution, le cours a pu bouger. La
--  réponse dit ce qui a réellement été prélevé.
-- ---------------------------------------------------------------------
create or replace function public.bourse_acheter(p_code text, p_nb int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix numeric; cout int; frais int; pos public.bourse_positions;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if p_nb is null or p_nb < 1 then raise exception 'Quantité invalide'; end if;
  if not exists (select 1 from public.bourse_societes where code = p_code and actif) then
    raise exception 'Société inconnue ou retirée de la cote';
  end if;

  prix  := public.bourse_cours_actuel(p_code);
  cout  := round(prix * p_nb);
  frais := greatest(1, round(cout * 0.01));
  if moi.gold < cout + frais then
    raise exception 'Il te manque % or', cout + frais - moi.gold;
  end if;

  update public.players set gold = gold - cout - frais where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -(cout + frais), 'bourse : achat ' || p_nb || ' × ' || p_code);

  select * into pos from public.bourse_positions where player_id = moi.id and code = p_code;
  if found then
    update public.bourse_positions
       set pru = (pos.pru * pos.nb + cout) / (pos.nb + p_nb), nb = pos.nb + p_nb
     where player_id = moi.id and code = p_code;
  else
    insert into public.bourse_positions (player_id, code, nb, pru)
    values (moi.id, p_code, p_nb, prix);
  end if;

  return jsonb_build_object('code', p_code, 'nb', p_nb, 'prix', prix,
                            'cout', cout, 'frais', frais, 'or', moi.gold - cout - frais);
end $$;

create or replace function public.bourse_vendre(p_code text, p_nb int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix numeric; brut int; frais int; pos public.bourse_positions;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if p_nb is null or p_nb < 1 then raise exception 'Quantité invalide'; end if;

  select * into pos from public.bourse_positions
   where player_id = moi.id and code = p_code for update;
  if not found or pos.nb < p_nb then raise exception 'Tu n''en as pas autant'; end if;

  prix  := public.bourse_cours_actuel(p_code);
  brut  := round(prix * p_nb);
  frais := greatest(1, round(brut * 0.01));

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
                            'or', moi.gold + brut - frais);
end $$;

revoke all     on function public.bourse_acheter(text, int) from public, anon;
revoke all     on function public.bourse_vendre(text, int)  from public, anon;
grant  execute on function public.bourse_acheter(text, int) to authenticated, service_role;
grant  execute on function public.bourse_vendre(text, int)  to authenticated, service_role;


-- ---------------------------------------------------------------------
--  7. LE COMMERCE SUIT LA BOURSE
--     Les fonctions d'achat facturent désormais le prix indexé, jamais
--     le prix de base.
-- ---------------------------------------------------------------------
/* L'ancienne version renvoyait une ligne de player_items. Postgres
   refuse de changer le type de retour d'une fonction existante : il
   faut la supprimer avant de la recreer. */
drop function if exists public.shop_buy_item(text);

create or replace function public.shop_buy_item(p_item text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; it public.items; prix int;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;

  select * into it from public.items where key = p_item and active;
  if not found then raise exception 'Objet introuvable'; end if;

  -- On n'achète que ce qu'on a déjà décroché en jeu.
  if not exists (select 1 from public.player_items
                  where player_id = moi.id and item_key = p_item) then
    raise exception 'Tu n''as jamais obtenu cet objet : il n''est pas en rayon pour toi';
  end if;

  prix := public.prix_indexe(it.price, it.rarity);
  if moi.gold < prix then raise exception 'Il te manque % or', prix - moi.gold; end if;

  update public.players set gold = gold - prix where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -prix, 'achat : ' || it.name);

  insert into public.player_items (player_id, item_key, source_match)
  values (moi.id, p_item, 'shop-' || gen_random_uuid());

  return jsonb_build_object('item', it.key, 'nom', it.name, 'prix', prix,
                            'base', it.price, 'or', moi.gold - prix);
end $$;

create or replace function public.shop_buy_box()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix int;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;

  prix := public.prix_indexe(500, 'coffre');
  if moi.gold < prix then raise exception 'Il te manque % or', prix - moi.gold; end if;

  update public.players set gold = gold - prix where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -prix, 'achat : un coffre');

  insert into public.player_boxes (player_id, source_match)
  values (moi.id, 'achat-' || gen_random_uuid());

  return jsonb_build_object('prix', prix, 'base', 500, 'or', moi.gold - prix,
    'restants', (select count(*) from public.player_boxes
                  where player_id = moi.id and opened_at is null));
end $$;

revoke all     on function public.shop_buy_item(text) from public, anon;
revoke all     on function public.shop_buy_box()      from public, anon;
grant  execute on function public.shop_buy_item(text) to authenticated, service_role;
grant  execute on function public.shop_buy_box()      to authenticated, service_role;


-- ---------------------------------------------------------------------
--  8. LE PREMIER RELEVÉ, ET LE CRON
--
--  On amorce deux cents bougies d'un coup pour que les graphiques
--  n'ouvrent pas sur une page blanche, puis le cron prend le relais
--  toutes les cinq minutes.
-- ---------------------------------------------------------------------
do $$
declare s bigint;
begin
  if not exists (select 1 from public.bourse_cours) then
    -- On remonte le temps : le premier créneau est deux cents relevés
    -- en arrière, et bourse_tick rattrape jusqu'à maintenant.
    update public.bourse_etat set slot = public.bourse_slot() - 200 where id = 1;
    perform public.bourse_tick(200);
  end if;
end $$;

do $$ begin
  perform cron.unschedule('bourse-tick');
exception when others then null; end $$;

do $$ begin
  perform cron.schedule('bourse-tick', '*/5 * * * *', $cron$select public.bourse_tick();$cron$);
exception when others then
  raise notice 'pg_cron indisponible : appelle bourse_tick() depuis le site.';
end $$;

/* Une vue d'une seule ligne : le site a besoin de l'indice pour
   afficher les prix du Commerce, et rapatrier dix cours pour en faire
   la moyenne dans le navigateur serait du gaspillage. */
create or replace view public.bourse_resume as
  select public.bourse_indice() as indice,
         (select secousse_reste from public.bourse_etat where id = 1) as secousse_reste,
         (select secousse_genre from public.bourse_etat where id = 1) as secousse_genre;

grant select on public.bourse_resume to anon, authenticated;

notify pgrst, 'reload schema';


-- Où en est le marché.
select s.code, s.nom, s.risque, s.lien,
       round(public.bourse_cours_actuel(s.code), 1) as cours,
       s.prix_base,
       round((public.bourse_cours_actuel(s.code) / s.prix_base - 1) * 100, 1) as depuis_ouverture_pct
  from public.bourse_societes s where s.actif order by s.sort;

select public.bourse_indice() as indice,
       public.prix_indexe(350, 'commun')     as un_commun,
       public.prix_indexe(500, 'coffre')     as un_coffre,
       public.prix_indexe(800, 'rare')       as un_rare,
       public.prix_indexe(1800,'legendaire') as un_legendaire;
