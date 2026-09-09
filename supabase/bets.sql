-- =====================================================================
--  PARTENAIRES DE DUO + PARIS VERROUILLÉS AVANT LA PARTIE
--  À coller dans Supabase > SQL Editor > Run. Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Avec qui a-t-on joué ?
-- ---------------------------------------------------------------------
alter table public.games
  add column if not exists partner_id text references public.players(id) on delete set null;

create index if not exists games_partner_idx on public.games (player_id, partner_id);

-- ---------------------------------------------------------------------
-- 2. `steal` devient `stake` : ce n'est plus un sacrifice de LP mais
--    une mise, qui change de camp selon le résultat.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='games' and column_name='steal')
  and not exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='games' and column_name='stake')
  then
    alter table public.games rename column steal to stake;
  end if;
end $$;

alter table public.games add column if not exists stake int not null default 0;

-- L'ancienne contrainte n'autorisait la mise que sur une victoire.
-- Un pari se perd aussi : on la remplace.
alter table public.games drop constraint if exists games_steal_valid;
do $$
begin
  alter table public.games add constraint games_stake_valid
    check (stake >= 0 and stake <= 50 and (stake = 0 or duo = 'enemy'));
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------
-- 3. Le pari en cours.
--    Une seule mise ouverte par joueur. Elle est posée AVANT la partie
--    et ne peut plus bouger : c'est tout l'intérêt.
-- ---------------------------------------------------------------------
create table if not exists public.pending_bets (
  player_id  text primary key references public.players(id) on delete cascade,
  partner_id text references public.players(id) on delete set null,
  stake      int not null check (stake between 0 and 50),
  opened_at  timestamptz not null default now()
);

alter table public.pending_bets enable row level security;

drop policy if exists bets_read   on public.pending_bets;
drop policy if exists bets_insert on public.pending_bets;
drop policy if exists bets_update on public.pending_bets;
drop policy if exists bets_delete on public.pending_bets;

-- Tout le monde voit les paris ouverts : ça fait partie du spectacle.
create policy bets_read on public.pending_bets for select to anon, authenticated using (true);

create policy bets_insert on public.pending_bets for insert to authenticated
  with check (public.owns_player(player_id) or public.is_admin());
create policy bets_delete on public.pending_bets for delete to authenticated
  using (public.owns_player(player_id) or public.is_admin());

-- Pas de policy UPDATE : une mise verrouillée ne se modifie pas.
-- Pour changer d'avis il faut annuler (delete) et rouvrir un pari.

-- ---------------------------------------------------------------------
-- 4. Une mise ne peut pas être posée après coup.
--    La partie déclarée doit correspondre à un pari réellement ouvert.
-- ---------------------------------------------------------------------
create or replace function public.guard_stake()
returns trigger language plpgsql security definer set search_path = public as $$
declare b record;
begin
  if auth.uid() is null then return new; end if;   -- SQL Editor / service_role
  if public.is_admin() then return new; end if;
  if coalesce(new.stake, 0) = 0 then return new; end if;

  select * into b from public.pending_bets where player_id = new.player_id;

  if b is null then
    raise exception 'Aucun pari ouvert : la mise doit être posée avant la partie.';
  end if;
  if b.stake <> new.stake then
    raise exception 'La mise déclarée (%) ne correspond pas au pari ouvert (%).', new.stake, b.stake;
  end if;

  return new;
end $$;

drop trigger if exists t_guard_stake on public.games;
create trigger t_guard_stake
  before insert on public.games
  for each row execute function public.guard_stake();

-- ---------------------------------------------------------------------
-- 5. Temps réel sur les paris ouverts
-- ---------------------------------------------------------------------
do $$
begin
  begin execute 'alter publication supabase_realtime add table public.pending_bets';
  exception when duplicate_object then null; end;
end $$;

select 'ok' as resultat;
