-- =====================================================================
--  LE PARI DEVIENT OBLIGATOIRE EN DUO ADVERSE
--  À coller dans Supabase > SQL Editor > Run. Idempotent.
--
--  Sans ça, la règle ne tiendrait qu'au JavaScript de la page : il
--  suffirait d'une requête forgée pour déclarer un duo adverse sans
--  mise. On la fait appliquer par Postgres.
--
--  MISE_MIN = 5 : une mise à 0 ne serait pas un pari. Change la valeur
--  ici ET dans app.js si tu veux un autre plancher.
-- =====================================================================

create or replace function public.guard_stake()
returns trigger language plpgsql security definer set search_path = public as $$
declare b record;
begin
  if auth.uid() is null then return new; end if;   -- SQL Editor / service_role
  if public.is_admin() then return new; end if;

  -- Un duo adverse sans mise n'existe pas.
  if new.duo = 'enemy' and coalesce(new.stake, 0) < 5 then
    raise exception 'Un duo adverse doit passer par un pari d''au moins 5 LP.';
  end if;

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

-- Le pari lui-même ne peut pas être ouvert en dessous du plancher.
alter table public.pending_bets drop constraint if exists pending_bets_stake_check;
do $$
begin
  alter table public.pending_bets add constraint pending_bets_stake_min
    check (stake between 5 and 50);
exception when duplicate_object then null;
end $$;

select 'ok' as resultat;
