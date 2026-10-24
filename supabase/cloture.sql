-- =====================================================================
--  cloture.sql — arrêter les machines, et archiver le challenge
--
--  POURQUOI CE SCRIPT
--
--  Le projet Supabase a été suspendu : « exceed_egress_quota ». Ce
--  n'est pas le STOCKAGE qui a débordé, c'est la bande passante
--  SORTANTE — cinq gigaoctets par mois sur le forfait gratuit.
--
--  La cause est dans le site, pas dans la base. La page écoutait les
--  changements de `sync_state` en temps réel, et rechargeait TOUT à
--  chaque fois : les parties, les objets, les coffres, le journal
--  d'or. Or le relevé automatique touche `sync_state` toutes les cinq
--  minutes. Chaque onglet resté ouvert rapatriait donc le challenge
--  entier 288 fois par jour.
--
--      288 relevés/jour × 21 jours × 2 onglets × ~400 Ko  ≈  4,6 Go
--
--  Le challenge est fini : ces machines n'ont plus rien à faire. On
--  les arrête, et on sort une archive pour que le site vive sans la
--  base.
--
--  À LANCER DANS LE SQL EDITOR — il reste accessible même quand l'API
--  est restreinte, c'est un autre chemin.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. ARRÊTER LES MACHINES
--
--  Les deux tâches tournaient toutes les cinq minutes. Le challenge est
--  clos : elles n'ont plus rien à relever, et c'est leur va-et-vient
--  qui nourrissait la facture.
-- ---------------------------------------------------------------------
do $$
declare j record; n int := 0;
begin
  for j in select jobname from cron.job where jobname in ('riot-sync','bourse-tick') loop
    perform cron.unschedule(j.jobname);
    n := n + 1;
    raise notice 'Tâche arrêtée : %', j.jobname;
  end loop;
  if n = 0 then raise notice 'Aucune tâche à arrêter.'; end if;
exception when undefined_table or undefined_function then
  raise notice 'pg_cron absent : rien à arrêter.';
end $$;

-- Ce qui reste programmé, s'il reste quelque chose.
select jobname, schedule, active from cron.job order by jobname;


-- ---------------------------------------------------------------------
--  2. VIDER L'HISTORIQUE DES TÂCHES
--
--  pg_cron garde une ligne par exécution, et personne ne la nettoie.
--  Deux tâches toutes les cinq minutes pendant trois semaines font une
--  douzaine de milliers de lignes dont plus rien ne dépend.
-- ---------------------------------------------------------------------
do $$
declare n int;
begin
  delete from cron.job_run_details where end_time < now();
  get diagnostics n = row_count;
  raise notice 'Historique des tâches : % ligne(s) effacée(s).', n;
exception when undefined_table or insufficient_privilege then
  raise notice 'Historique des tâches inaccessible : on passe.';
end $$;


-- ---------------------------------------------------------------------
--  3. COUPER LE TEMPS RÉEL
--
--  Plus rien ne bouge : laisser les tables publiées entretiendrait des
--  connexions permanentes pour ne rien transmettre.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select tablename from pg_publication_tables where pubname = 'supabase_realtime'
  loop
    execute format('alter publication supabase_realtime drop table public.%I', t);
    raise notice 'Retirée du temps réel : %', t;
  end loop;
exception when others then
  raise notice 'Publication temps réel : % ', sqlerrm;
end $$;


-- ---------------------------------------------------------------------
--  4. L'ARCHIVE
--
--  Tout ce que le site affiche, en un seul document. Copie le résultat
--  de cette requête dans `archive.json`, à la racine du dépôt : le
--  site s'en servira et n'appellera plus jamais la base.
--
--  Les cours de la Place sont volontairement dégrossis — un point sur
--  six, soit un toutes les trente minutes. Deux mille bougies par
--  société pèsent lourd pour un graphique qu'on ne regardera plus que
--  de loin, et la forme de la courbe ne change pas.
-- ---------------------------------------------------------------------
select jsonb_pretty(jsonb_build_object(
  'fige_le',   now(),
  'challenge', (select to_jsonb(c) from public.challenge c where id = 1),
  'players',   (select coalesce(jsonb_agg(to_jsonb(p) order by p.sort), '[]'::jsonb)
                  from public.players p),
  'profiles',  (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', pr.id, 'display_name', pr.display_name,
                    'avatar_url', pr.avatar_url, 'is_admin', false)), '[]'::jsonb)
                  from public.profiles pr),
  'games',     (select coalesce(jsonb_agg(to_jsonb(g) order by g.created_at), '[]'::jsonb)
                  from public.games g),
  'snaps',     (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
                  from public.rank_snapshots r),
  'items',     (select coalesce(jsonb_agg(to_jsonb(i) order by i.sort), '[]'::jsonb)
                  from public.items i),
  'inventory', (select coalesce(jsonb_agg(to_jsonb(pi) order by pi.obtained_at), '[]'::jsonb)
                  from public.player_items pi),
  'boxes',     (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb)
                  from public.player_boxes b),
  'ledger',    (select coalesce(jsonb_agg(to_jsonb(l) order by l.at desc), '[]'::jsonb)
                  from (select * from public.gold_ledger order by at desc limit 200) l),
  'sync',      (select to_jsonb(s) from public.sync_state s where id = 1),
  'bourse',    (select to_jsonb(v) from public.bourse_resume v),
  'societes',  (select coalesce(jsonb_agg(to_jsonb(so) order by so.sort), '[]'::jsonb)
                  from public.bourse_societes so where so.actif),
  'cours',     (select coalesce(jsonb_agg(jsonb_build_object(
                    'code', c.code, 'slot', c.slot, 'o', c.o, 'h', c.h, 'b', c.b, 'c', c.c)
                    order by c.slot), '[]'::jsonb)
                  from public.bourse_cours c where c.slot % 6 = 0),
  'depeches',  (select coalesce(jsonb_agg(to_jsonb(d) order by d.at desc), '[]'::jsonb)
                  from (select * from public.bourse_depeches order by at desc limit 60) d),
  'positions', (select coalesce(jsonb_agg(to_jsonb(po)), '[]'::jsonb)
                  from public.bourse_positions po),
  'rewind',      (select to_jsonb(r) from public.rewind r where id = 1),
  'rewcats',     (select coalesce(jsonb_agg(to_jsonb(rc) order by rc.ordre), '[]'::jsonb)
                    from public.rewind_categories rc),
  'bataille',    (select to_jsonb(b) from public.bataille b where id = 1),
  'inscrits',    (select coalesce(jsonb_agg(to_jsonb(bi)), '[]'::jsonb)
                    from public.bataille_inscrits bi),
  -- Tout est révélé : la soirée est passée, il n'y a plus rien à cacher.
  'duels',       (select coalesce(jsonb_agg(jsonb_build_object(
                      'id', d.id, 'manche', d.manche, 'revele', true,
                      'joueur_a', d.joueur_a, 'joueur_b', d.joueur_b,
                      'champion', d.champion, 'gagnant', d.gagnant) order by d.id), '[]'::jsonb)
                    from public.bataille_duels d),
  'champions',   (select coalesce(jsonb_agg(to_jsonb(ch)), '[]'::jsonb)
                    from public.bataille_champions ch)
)) as archive;
