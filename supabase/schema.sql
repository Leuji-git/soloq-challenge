-- =====================================================================
--  SoloQ Challenge — schéma Supabase
--  À coller entièrement dans Supabase > SQL Editor > New query > Run.
--  Idempotent : tu peux le relancer sans casser les données existantes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

-- Profil applicatif, créé automatiquement à la première connexion.
create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  display_name text,
  avatar_url  text,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Réglages du challenge : une seule ligne, id = 1.
create table if not exists public.challenge (
  id          int primary key default 1,
  name        text not null default 'Les Médiocres contre Les Pitoyables',
  start_date  date not null default '2026-10-01',
  days        int  not null default 21 check (days between 1 and 365),
  team_a_name text not null default 'Les Médiocres',
  team_b_name text not null default 'Les Pitoyables',
  constraint challenge_single_row check (id = 1)
);

-- Les slots joueurs. `claimed_by` = le compte qui a réclamé ce slot.
create table if not exists public.players (
  id         text primary key,
  name       text not null,
  tag        text not null default '',
  team       text not null check (team in ('a','b')),
  seed_score int  not null default 0,          -- rang de départ, converti en points
  claimed_by uuid unique references auth.users on delete set null,
  sort       int  not null default 0
);

-- Une ligne = une partie. C'est la seule source du classement.
create table if not exists public.games (
  id         uuid primary key default gen_random_uuid(),
  player_id  text not null references public.players on delete cascade,
  lp         int  not null check (lp between -200 and 200 and lp <> 0),
  win        boolean not null,
  played_on  date not null default current_date,
  created_by uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists games_player_idx on public.games (player_id, created_at);

-- Duo : 'solo', 'team' (coéquipier) ou 'enemy' (adversaire).
-- `steal` = LP arrachés à l'équipe adverse sur une victoire en duo adverse.
alter table public.games add column if not exists duo   text not null default 'solo';
alter table public.games add column if not exists steal int  not null default 0;

do $$
begin
  alter table public.games add constraint games_duo_valid check (duo in ('solo','team','enemy'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.games add constraint games_steal_valid
    check (steal >= 0 and (steal = 0 or (duo = 'enemy' and win and steal <= lp)));
exception when duplicate_object then null;
end $$;

-- Recalage cosmétique du rang affiché (ne touche jamais au score).
create table if not exists public.rank_syncs (
  player_id text primary key references public.players on delete cascade,
  score     int not null,
  synced_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. FONCTIONS UTILITAIRES
--    security definer => elles lisent les tables en ignorant la RLS,
--    ce qui évite une récursion infinie dans les policies.
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.owns_player(p text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.players pl
    where pl.id = p and pl.claimed_by = auth.uid()
  );
$$;

-- Création automatique du profil à l'inscription.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'user_name',
      split_part(coalesce(new.email,'joueur@'), '@', 1)
    ),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Personne ne se promeut administrateur tout seul.
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- SQL Editor / service_role : auth.uid() est NULL, on laisse passer.
  -- Un anonyme du site est bloque en amont par les policies `to authenticated`.
  if auth.uid() is null then return new; end if;
  if new.is_admin is distinct from old.is_admin and not public.is_admin() then
    raise exception 'Seul un administrateur peut modifier ce droit';
  end if;
  new.id := old.id;
  return new;
end $$;

drop trigger if exists t_guard_profile_update on public.profiles;
create trigger t_guard_profile_update
  before update on public.profiles
  for each row execute function public.guard_profile_update();

-- Un joueur non-admin ne peut QUE réclamer un slot libre ou libérer le sien.
-- Il ne peut ni renommer un joueur, ni le changer d'équipe, ni voler un slot.
create or replace function public.guard_player_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- SQL Editor / service_role
  if public.is_admin() then
    return new;
  end if;

  if row(new.id, new.name, new.tag, new.team, new.seed_score, new.sort)
     is distinct from
     row(old.id, old.name, old.tag, old.team, old.seed_score, old.sort) then
    raise exception 'Seul un administrateur peut modifier la fiche d''un joueur';
  end if;

  if not (
       (old.claimed_by is null          and new.claimed_by = auth.uid())
    or (old.claimed_by = auth.uid()     and new.claimed_by is null)
  ) then
    raise exception 'Ce profil joueur appartient déjà à quelqu''un d''autre';
  end if;

  return new;
end $$;

drop trigger if exists t_guard_player_update on public.players;
create trigger t_guard_player_update
  before update on public.players
  for each row execute function public.guard_player_update();

-- Aucune partie hors de la fenêtre du challenge (les admins peuvent corriger).
create or replace function public.guard_game_window()
returns trigger language plpgsql security definer set search_path = public as $$
declare s date; d int;
begin
  if auth.uid() is null then return new; end if;   -- SQL Editor / service_role
  if public.is_admin() then return new; end if;
  select start_date, days into s, d from public.challenge where id = 1;
  if s is null then return new; end if;
  if new.played_on < s then
    raise exception 'Le challenge ouvre le % : aucune partie ne peut être déclarée avant.', to_char(s, 'DD/MM/YYYY');
  end if;
  if new.played_on > s + d then
    raise exception 'Le challenge est terminé depuis le %.', to_char(s + d, 'DD/MM/YYYY');
  end if;
  return new;
end $$;

drop trigger if exists t_guard_game_window on public.games;
create trigger t_guard_game_window
  before insert or update on public.games
  for each row execute function public.guard_game_window();

-- ---------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
--    C'est ici que se joue « je ne peux pas toucher aux LP des autres ».
--    Ces règles sont appliquées par Postgres, pas par le navigateur :
--    trafiquer le JavaScript de la page ne les contourne pas.
-- ---------------------------------------------------------------------

alter table public.profiles   enable row level security;
alter table public.challenge  enable row level security;
alter table public.players    enable row level security;
alter table public.games      enable row level security;
alter table public.rank_syncs enable row level security;

-- --- profiles ---
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;

create policy profiles_read   on public.profiles for select to anon, authenticated using (true);
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- --- challenge : lecture publique, écriture admin ---
drop policy if exists challenge_read   on public.challenge;
drop policy if exists challenge_write  on public.challenge;
drop policy if exists challenge_insert on public.challenge;

create policy challenge_read   on public.challenge for select to anon, authenticated using (true);
create policy challenge_write  on public.challenge for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy challenge_insert on public.challenge for insert to authenticated
  with check (public.is_admin());

-- --- players : lecture publique, écriture filtrée par le trigger ci-dessus ---
drop policy if exists players_read   on public.players;
drop policy if exists players_update on public.players;
drop policy if exists players_insert on public.players;
drop policy if exists players_delete on public.players;

create policy players_read   on public.players for select to anon, authenticated using (true);
create policy players_update on public.players for update to authenticated
  using (public.is_admin() or claimed_by is null or claimed_by = auth.uid())
  with check (public.is_admin() or claimed_by is null or claimed_by = auth.uid());
create policy players_insert on public.players for insert to authenticated
  with check (public.is_admin());
create policy players_delete on public.players for delete to authenticated
  using (public.is_admin());

-- --- games : LA règle qui compte ---
drop policy if exists games_read   on public.games;
drop policy if exists games_insert on public.games;
drop policy if exists games_update on public.games;
drop policy if exists games_delete on public.games;

-- tout le monde lit le classement, même sans compte
create policy games_read on public.games for select to anon, authenticated using (true);

-- on n'écrit QUE sur le slot joueur qu'on a réclamé
create policy games_insert on public.games for insert to authenticated
  with check (created_by = auth.uid() and (public.owns_player(player_id) or public.is_admin()));

create policy games_update on public.games for update to authenticated
  using      (public.owns_player(player_id) or public.is_admin())
  with check (public.owns_player(player_id) or public.is_admin());

create policy games_delete on public.games for delete to authenticated
  using (public.owns_player(player_id) or public.is_admin());

-- --- rank_syncs : même règle ---
drop policy if exists syncs_read  on public.rank_syncs;
drop policy if exists syncs_write on public.rank_syncs;
drop policy if exists syncs_upd   on public.rank_syncs;
drop policy if exists syncs_del   on public.rank_syncs;

create policy syncs_read  on public.rank_syncs for select to anon, authenticated using (true);
create policy syncs_write on public.rank_syncs for insert to authenticated
  with check (public.owns_player(player_id) or public.is_admin());
create policy syncs_upd   on public.rank_syncs for update to authenticated
  using      (public.owns_player(player_id) or public.is_admin())
  with check (public.owns_player(player_id) or public.is_admin());
create policy syncs_del   on public.rank_syncs for delete to authenticated
  using (public.owns_player(player_id) or public.is_admin());

-- ---------------------------------------------------------------------
-- 4. TEMPS RÉEL — le tableau se met à jour chez tout le monde
-- ---------------------------------------------------------------------
do $$
begin
  begin execute 'alter publication supabase_realtime add table public.games';      exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.players';    exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.rank_syncs'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.challenge';  exception when duplicate_object then null; end;
end $$;

-- ---------------------------------------------------------------------
-- 5. DONNÉES DE DÉPART
--    Modifie la date, les noms d'équipes et les rangs de départ ici,
--    ou plus tard depuis le panneau Administration du site.
--    Barème : palier x 400 + division x 100 + LP
--    Fer 0 · Bronze 400 · Argent 800 · Or 1200 · Platine 1600
--    Émeraude 2000 · Diamant 2400 · Maître 2800+
-- ---------------------------------------------------------------------

insert into public.challenge (id, name, start_date, days, team_a_name, team_b_name)
values (1, 'Les Médiocres contre Les Pitoyables', '2026-10-01', 21, 'Les Médiocres', 'Les Pitoyables')
on conflict (id) do nothing;

insert into public.players (id, name, tag, team, seed_score, sort) values
  ('nameless', 'NamelessDivnity', 'EUW',   'a', 2045, 1),
  ('flinkiis', 'FlinkiiS',        'EUW',   'a', 1812, 2),
  ('maxou',    'Metaxou',         'Meta',  'a', 1578, 3),
  ('runailen', 'Runailen',        '1051',  'a', 2433, 4),
  ('leuji',    'LEUJI',           'OIOIO', 'b', 1660, 5),
  ('bigmat',   'Le Big Mat',      '4583',  'b', 1320, 6),
  ('minorv',   'Minorv',          '0904',  'b', 2205, 7),
  ('snooze',   'Snoozenlaw31',    '6262',  'b', 1190, 8)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 6. APRÈS TA PREMIÈRE CONNEXION SUR LE SITE
--    Reviens ici et lance ces deux requêtes pour devenir administrateur.
-- ---------------------------------------------------------------------
--   select id, display_name from public.profiles;
--   update public.profiles set is_admin = true where id = 'colle-ton-uuid-ici';
