-- =====================================================================
--  rewind.sql — le Rewind du challenge
--
--  Douze catégories, cent LP chacune pour le camp du vainqueur. Six
--  récompensent la nullité — c'est l'esprit de la maison — et six
--  récompensent le jeu, pour que ceux qui ont bien joué y trouvent
--  aussi leur compte.
--
--  TROIS CHOSES À SAVOIR AVANT DE LANCER
--
--  1. Douze catégories à 100 LP font 1 200 LP sur la table. C'est plus
--     que l'écart actuel du challenge : le Rewind peut donc décider du
--     résultat à lui seul. Si ce n'est pas voulu, baisse le montant :
--         update public.rewind set par_categorie = 50 where id = 1;
--
--  2. Rien n'est attribué automatiquement. L'administrateur voit les
--     vainqueurs calculés, les vérifie, et donne les LP catégorie par
--     catégorie — ou tout d'un coup. Chaque don est réversible.
--
--  3. Les vainqueurs sont calculés PAR LA PAGE, pas ici. Le serveur ne
--     fait que valider la catégorie et enregistrer le don : c'est un
--     geste d'administrateur, pas un calcul automatique. Relis les
--     chiffres avant de cliquer.
--
--  Idempotent.
-- =====================================================================

/* La durée d'une partie était calculée par la fonction Riot — les
   Bottes de Célérité s'en servent — mais jamais enregistrée. Sans elle,
   impossible de compter les heures passées sur la Faille. */
alter table public.games add column if not exists duree_min numeric;


create table if not exists public.rewind (
  id            int primary key default 1,
  par_categorie int not null default 100,
  constraint rewind_une_seule check (id = 1)
);
insert into public.rewind (id, par_categorie) values (1, 100)
on conflict (id) do nothing;

/* Les catégories vivent ici, et pas seulement dans la page : c'est
   cette liste qui autorise un don. Le libellé peut changer sans
   redéploiement, la clé non — c'est elle que le calcul utilise. */
create table if not exists public.rewind_categories (
  cle    text primary key,
  nom    text not null,
  sous   text not null,          -- ce que la catégorie mesure, en clair
  camp   text not null check (camp in ('nul','bon')),
  icone  text not null default '🏆',
  ordre  int  not null default 0
);

insert into public.rewind_categories (cle, nom, sous, camp, icone, ordre) values
  -- ---- le côté obscur ----------------------------------------------
  ('charnier',   'Le Charnier',      'le plus de morts sur tout le challenge',        'nul', '💀', 1),
  ('don_de_soi', 'Le Don de Soi',    'le plus de morts par partie',                   'nul', '🪦', 2),
  ('aveugle',    'L''Aveugle',       'la plus mauvaise vision moyenne',               'nul', '🌑', 3),
  ('chute',      'La Chute Libre',   'la pire journée en LP',                         'nul', '📉', 4),
  ('glacon',     'Le Glaçon',        'la plus longue série de défaites',              'nul', '🧊', 5),
  ('sisyphe',    'Le Sisyphe',       'le plus de parties pour le moins de LP',        'nul', '🪨', 6),
  ('faille',     'Le Temps Perdu',   'le plus d''heures laissées sur la Faille',      'nul', '⏳', 7),
  -- ---- le côté lumineux --------------------------------------------
  ('monarque',   'Le Monarque',      'le plus de LP nets',                            'bon', '👑', 8),
  ('bourreau',   'Le Bourreau',      'le plus d''éliminations',                       'bon', '⚔️', 9),
  ('increvable', 'L''Increvable',    'le moins de morts par partie',                  'bon', '🛡️', 10),
  ('invaincu',   'L''Invaincu',      'la plus longue série de victoires',             'bon', '🔥', 11),
  ('oeil',       'L''Œil',           'la meilleure vision moyenne',                   'bon', '👁️', 12),
  ('dompteur',   'Le Dompteur',      'le plus de dragons et de barons',               'bon', '🐲', 13)
on conflict (cle) do update
  set nom = excluded.nom, sous = excluded.sous, camp = excluded.camp,
      icone = excluded.icone, ordre = excluded.ordre;

alter table public.rewind            enable row level security;
alter table public.rewind_categories enable row level security;
drop policy if exists rewind_read     on public.rewind;
drop policy if exists rewind_cat_read on public.rewind_categories;
create policy rewind_read     on public.rewind            for select to anon, authenticated using (true);
create policy rewind_cat_read on public.rewind_categories for select to anon, authenticated using (true);

-- Les LP du Rewind arrivent sur une ligne de partie d'un genre nouveau.
alter table public.games drop constraint if exists games_kind_valid;
do $$ begin
  alter table public.games add constraint games_kind_valid
    check (kind in ('game','adjust','shop','peage','renvoi','partage','bataille','rewind'));
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
--  DONNER les LP d'une catégorie
--
--  Réservé à l'administrateur. Le matricule est stable, et l'index
--  unique (player_id, match_id) refuse le doublon : cliquer deux fois
--  ne donne pas deux fois. Plusieurs ex æquo sont acceptés — chacun
--  reçoit la somme pleine, et c'est voulu : départager au hasard serait
--  pire que récompenser deux fois.
-- ---------------------------------------------------------------------
create or replace function public.rewind_donner(p_cle text, p_player text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare montant int; cat public.rewind_categories; j public.players;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;

  select * into cat from public.rewind_categories where cle = p_cle;
  if not found then raise exception 'Catégorie inconnue : %', p_cle; end if;

  select * into j from public.players where id = p_player and alias_of is null;
  if not found then raise exception 'Joueur inconnu : %', p_player; end if;

  select par_categorie into montant from public.rewind where id = 1;

  insert into public.games (player_id, lp, lp_items, win, duo, kind,
                            match_id, played_on, created_at)
  values (j.id, 0, montant, true, 'solo', 'rewind',
          'rewind-' || p_cle || '-' || j.id, current_date, now())
  on conflict do nothing;

  return jsonb_build_object('cle', p_cle, 'joueur', j.id, 'lp', montant);
end $$;

-- Retirer un don : le Rewind est une v1, on doit pouvoir se dédire.
create or replace function public.rewind_retirer(p_cle text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  delete from public.games
   where kind = 'rewind' and match_id like 'rewind-' || p_cle || '-%';
  get diagnostics n = row_count;
  return jsonb_build_object('cle', p_cle, 'retires', n);
end $$;

revoke all     on function public.rewind_donner(text, text) from public, anon;
revoke all     on function public.rewind_retirer(text)      from public, anon;
grant  execute on function public.rewind_donner(text, text) to authenticated, service_role;
grant  execute on function public.rewind_retirer(text)      to authenticated, service_role;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
--  Vérification
-- ---------------------------------------------------------------------
select par_categorie, par_categorie * (select count(*) from public.rewind_categories)
       as total_en_jeu
  from public.rewind where id = 1;

/* Combien de parties portent déjà leur durée. Tant que ce n'est pas
   proche de 100 %, « Le Temps Perdu » favorise ceux qui ont joué
   récemment : lance le rattrapage depuis la console admin. */
select count(*) filter (where duree_min is not null) as avec_duree,
       count(*) as parties,
       round(100.0 * count(*) filter (where duree_min is not null)
             / greatest(1, count(*)), 1) as couverture_pct
  from public.games where kind = 'game';

select ordre, icone, nom, camp, sous from public.rewind_categories order by ordre;

select match_id, player_id, lp_items from public.games
 where kind = 'rewind' order by match_id;
