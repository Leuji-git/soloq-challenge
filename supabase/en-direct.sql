-- =====================================================================
--  en-direct.sql — qui est en train de jouer
--
--  Spectator-V5 dit si un joueur est actuellement en partie, et depuis
--  quand. On enregistre ça dans une table à part : une ligne par joueur
--  en jeu, supprimée dès qu'il en sort.
--
--  Le compteur, lui, n'est pas stocké : le site le calcule à partir de
--  started_at et le fait avancer chaque seconde. Une valeur figée en
--  base serait fausse l'instant d'après.
--
--  Idempotent.
-- =====================================================================

create table if not exists public.live_games (
  player_id  text primary key references public.players(id) on delete cascade,
  match_id   text,
  started_at timestamptz,
  champion   text,
  queue      int,
  seen_at    timestamptz not null default now()
);

alter table public.live_games enable row level security;

drop policy if exists live_read on public.live_games;
-- Lecture publique : savoir qui joue est tout l'intérêt. Aucune policy
-- d'écriture : seule la fonction « riot » alimente cette table.
create policy live_read on public.live_games
  for select to anon, authenticated using (true);

do $$ begin
  begin execute 'alter publication supabase_realtime add table public.live_games';
  exception when duplicate_object then null; end;
end $$;


-- Quand a-t-on interrogé Spectator pour la dernière fois ? Ce passage
-- coûte un appel Riot par joueur : il a son propre rythme, plus lent
-- que le relevé des rangs, pour ne pas menacer le quota.
alter table public.sync_state add column if not exists live_at timestamptz;

create or replace function public.riot_try_live()
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  update public.sync_state
     set live_at = now()
   where id = 1
     and (live_at is null or live_at < now() - interval '2 minutes')
  returning true into ok;
  return coalesce(ok, false);
end $$;

revoke all     on function public.riot_try_live() from public, anon, authenticated;
grant  execute on function public.riot_try_live() to service_role;

notify pgrst, 'reload schema';

select * from public.live_games;
