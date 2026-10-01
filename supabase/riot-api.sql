-- =====================================================================
--  SUIVI AUTOMATIQUE PAR L'API RIOT
--  À coller dans Supabase > SQL Editor > Run. Idempotent.
--
--  À lancer APRÈS avoir déployé la fonction « riot » (voir README).
--  Une fois ce script passé, plus personne ne peut déclarer de partie
--  depuis le navigateur : seule la fonction écrit dans `games`.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Les colonnes et tables du suivi
-- ---------------------------------------------------------------------

-- L'identifiant Riot permanent du joueur. Un compte ne s'inscrit qu'une fois.
alter table public.players add column if not exists puuid text;
create unique index if not exists players_puuid_key on public.players (puuid) where puuid is not null;

-- Le dernier rang relevé chez Riot : base de calcul des LP.
create table if not exists public.rank_snapshots (
  player_id  text primary key references public.players(id) on delete cascade,
  ranked     boolean not null default false,
  tier       text,
  division   int,
  lp         int not null default 0,
  wins       int not null default 0,
  losses     int not null default 0,
  score      int not null default 0,
  checked_at timestamptz not null default now()
);

-- Les parties viennent de l'API : on garde l'identifiant Riot pour ne
-- jamais compter deux fois la même, et le champion pour l'historique.
alter table public.games add column if not exists match_id text;
alter table public.games add column if not exists champion text;
alter table public.games add column if not exists approx   boolean not null default false;
alter table public.games add column if not exists kind     text    not null default 'game';
create unique index if not exists games_player_match_key on public.games (player_id, match_id) where match_id is not null;

do $$ begin
  alter table public.games add constraint games_kind_valid check (kind in ('game','adjust'));
exception when duplicate_object then null; end $$;

-- La fonction écrit avec la clé serveur : pas d'utilisateur connecté derrière.
alter table public.games alter column created_by drop not null;

-- Une défaite à 0 LP (Fer IV) existe : on autorise le 0.
alter table public.games drop constraint if exists games_lp_check;
do $$ begin
  alter table public.games add constraint games_lp_range check (lp between -200 and 200);
exception when duplicate_object then null; end $$;

-- État du relevé : visible par tous, pour repérer un suivi en panne.
create table if not exists public.sync_state (
  id            int primary key default 1 check (id = 1),
  last_run      timestamptz,
  last_ok       timestamptz,
  last_error    text,
  running_until timestamptz
);
insert into public.sync_state (id) values (1) on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 2. Fonctions réservées au serveur
--    SECURITY DEFINER + révocation explicite : Postgres accorde EXECUTE
--    à tout le monde par défaut, et Supabase expose les fonctions via
--    l'API. Sans le REVOKE, un visiteur pourrait s'inscrire sans passer
--    par la vérification du compte Riot.
-- ---------------------------------------------------------------------

-- Verrou + étranglement : un relevé à la fois, au plus toutes les 150 s.
create or replace function public.riot_try_start_sync(p_force boolean default false)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  insert into public.sync_state (id) values (1) on conflict (id) do nothing;
  update public.sync_state
     set running_until = now() + interval '100 seconds', last_run = now()
   where id = 1
     and (running_until is null or running_until < now())
     and (p_force or last_run is null or last_run < now() - interval '240 seconds')
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.riot_finish_sync(p_error text default null)
returns void language sql security definer set search_path = public as $$
  update public.sync_state
     set running_until = null,
         last_ok    = case when p_error is null then now() else last_ok end,
         last_error = p_error
   where id = 1;
$$;

-- Inscription atomique : l'équipe est tirée ici, sous verrou, pour que
-- deux inscriptions simultanées ne tombent pas toutes deux dans la même.
create or replace function public.riot_register_player(
  p_user uuid, p_name text, p_tag text, p_puuid text, p_score int)
returns public.players language plpgsql security definer set search_path = public as $$
declare na int; nb int; t text; slug text; r public.players;
begin
  perform pg_advisory_xact_lock(424242);

  select count(*) filter (where team = 'a'), count(*) filter (where team = 'b')
    into na, nb from public.players;
  if    na < nb then t := 'a';
  elsif nb < na then t := 'b';
  else               t := case when random() < 0.5 then 'a' else 'b' end;
  end if;

  slug := trim(both '-' from lower(regexp_replace(p_name || '-' || p_tag, '[^a-zA-Z0-9]+', '-', 'g')));
  if slug = '' or exists (select 1 from public.players where id = slug) then
    slug := coalesce(nullif(slug, ''), 'joueur') || '-' || substr(md5(random()::text), 1, 4);
  end if;

  insert into public.players (id, name, tag, team, seed_score, claimed_by, puuid, sort)
  values (slug, p_name, p_tag, t, p_score, p_user, p_puuid,
          coalesce((select max(sort) from public.players), 0) + 1)
  returning * into r;
  return r;
end $$;

revoke all on function public.riot_try_start_sync(boolean)                    from public, anon, authenticated;
revoke all on function public.riot_finish_sync(text)                          from public, anon, authenticated;
revoke all on function public.riot_register_player(uuid, text, text, text, int) from public, anon, authenticated;
grant execute on function public.riot_try_start_sync(boolean)                    to service_role;
grant execute on function public.riot_finish_sync(text)                          to service_role;
grant execute on function public.riot_register_player(uuid, text, text, text, int) to service_role;


-- ---------------------------------------------------------------------
-- 3. Tout automatique : on ferme les écritures depuis le navigateur
-- ---------------------------------------------------------------------
alter table public.rank_snapshots enable row level security;
alter table public.sync_state     enable row level security;

drop policy if exists snapshots_read on public.rank_snapshots;
create policy snapshots_read on public.rank_snapshots for select to anon, authenticated using (true);

drop policy if exists sync_read on public.sync_state;
create policy sync_read on public.sync_state for select to anon, authenticated using (true);

-- Parties : plus aucune déclaration. L'admin peut seulement en supprimer une.
drop policy if exists games_insert on public.games;
drop policy if exists games_update on public.games;
drop policy if exists games_delete on public.games;
create policy games_delete on public.games for delete to authenticated using (public.is_admin());

-- Inscription : uniquement via la fonction, qui vérifie le compte chez Riot.
drop policy if exists players_insert on public.players;
create policy players_insert on public.players for insert to authenticated with check (public.is_admin());

-- Paris : ouverts et annulés via la fonction, qui vérifie si tu es en partie.
drop policy if exists bets_insert on public.pending_bets;
drop policy if exists bets_delete on public.pending_bets;
create policy bets_delete on public.pending_bets for delete to authenticated using (public.is_admin());

-- Fiches joueurs : plus rien de modifiable par un joueur. Sans ce verrou,
-- quelqu'un pourrait remplacer son puuid par celui d'un Challenger.
create or replace function public.guard_player_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- fonction serveur / SQL Editor
  if public.is_admin() then return new; end if;
  raise exception 'Les fiches joueurs sont gérées automatiquement.';
end $$;


-- ---------------------------------------------------------------------
-- 4. Temps réel
-- ---------------------------------------------------------------------
do $$ begin
  begin execute 'alter publication supabase_realtime add table public.rank_snapshots'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.sync_state';     exception when duplicate_object then null; end;
end $$;


-- ---------------------------------------------------------------------
-- 5. Relevé toutes les 5 minutes
--    Si pg_cron refuse de s'activer ici, active-le d'abord dans
--    Database > Extensions (pg_cron et pg_net), puis relance ce bloc.
-- ---------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'riot-sync';

select cron.schedule('riot-sync', '*/5 * * * *', $cron$
  select net.http_post(
    url := 'https://krdohsbydwvuyoegbsub.supabase.co/functions/v1/riot',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "sync"}'::jsonb,
    timeout_milliseconds := 60000
  );
$cron$);

select jobid, jobname, schedule from cron.job where jobname = 'riot-sync';
