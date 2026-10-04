-- =====================================================================
--  boutique-v2.sql — nouveau rayon
--
--  Trois produits remplacent les trois lots de LP :
--    * 25 LP               2 000 or
--    * Double LP, 2 heures 5 000 or
--    * Changer d'équipe   25 000 or
--
--  Les lots de 10 et 50 LP disparaissent.
--  À lancer après economie.sql. Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. Le bonus de doublement — il appartient à l'ÉQUIPE
--
--  Un joueur l'achète, toute son équipe en profite pendant deux heures.
--  Il vit donc ici et pas sur la fiche du joueur : sinon il faudrait le
--  recopier sur chacun, et il se désynchroniserait au premier échange
--  d'équipe.
-- ---------------------------------------------------------------------
create table if not exists public.team_boosts (
  team      text primary key check (team in ('a','b')),
  until     timestamptz not null,
  bought_by text references public.players(id) on delete set null,
  at        timestamptz not null default now()
);

alter table public.team_boosts enable row level security;
drop policy if exists boosts_read on public.team_boosts;
-- Lecture publique : l'équipe d'en face doit pouvoir voir qu'on double.
create policy boosts_read on public.team_boosts
  for select to anon, authenticated using (true);

do $$ begin
  begin execute 'alter publication supabase_realtime add table public.team_boosts';
  exception when duplicate_object then null; end;
end $$;


-- ---------------------------------------------------------------------
--  2. La porte du changement d'équipe
--
--  Le déclencheur de garde interdit à un joueur de toucher à son équipe
--  — c'est volontaire, et ça doit le rester. On lui ajoute une seule
--  exception : un réglage de transaction que seule shop_swap_team pose,
--  le temps de son échange. Un client ne peut pas le poser lui-même :
--  PostgREST n'expose pas set_config.
-- ---------------------------------------------------------------------
create or replace function public.guard_player_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- SQL Editor / service_role
  if public.is_admin() then return new; end if;
  -- L'échange d'équipe acheté en boutique, et lui seul.
  if coalesce(current_setting('app.team_swap', true), '') = 'on' then return new; end if;

  if row(new.id, new.name, new.tag, new.team, new.seed_score, new.sort)
     is distinct from
     row(old.id, old.name, old.tag, old.team, old.seed_score, old.sort) then
    raise exception 'Seul un administrateur peut modifier la fiche d''un joueur';
  end if;

  if not (
       (old.claimed_by is null      and new.claimed_by = auth.uid())
    or (old.claimed_by = auth.uid() and new.claimed_by is null)
  ) then
    raise exception 'Ce profil joueur appartient déjà à quelqu''un d''autre';
  end if;

  return new;
end $$;


-- ---------------------------------------------------------------------
--  3. Les LP : un seul lot désormais
-- ---------------------------------------------------------------------
create or replace function public.shop_buy_lp(p_lp int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix int := 2000;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if p_lp <> 25 then raise exception 'Le seul lot disponible est de 25 LP'; end if;
  if moi.gold < prix then raise exception 'Il te manque % or', prix - moi.gold; end if;

  update public.players set gold = gold - prix where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -prix, 'achat : 25 LP');

  -- lp = 0 : le classement individuel ne bouge pas.
  -- lp_items = 25 : le total global, lui, les prend.
  insert into public.games (player_id, lp, lp_items, win, duo, kind, match_id, played_on, created_by)
  values (moi.id, 0, 25, true, 'solo', 'shop',
          'shop-' || gen_random_uuid(), current_date, auth.uid());

  return jsonb_build_object('lp', 25, 'prix', prix, 'gold', moi.gold - prix);
end $$;


-- ---------------------------------------------------------------------
--  4. Double LP pendant deux heures
--
--  Ne double que les GAINS, et seulement sur les parties terminées dans
--  la fenêtre. Le doublement vit dans le total global, comme tout ce
--  qui n'est pas du LP Riot : le classement individuel ne bouge pas.
--  Un achat pendant un bonus en cours prolonge de deux heures à partir
--  de la fin en cours, il ne l'écrase pas.
-- ---------------------------------------------------------------------
create or replace function public.shop_buy_boost()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix int := 5000; fin timestamptz; actuel timestamptz;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if moi.gold < prix then raise exception 'Il te manque % or', prix - moi.gold; end if;

  -- On prolonge si l'équipe est déjà sous bonus, on ne l'écrase pas :
  -- deux joueurs qui achètent coup sur coup doivent cumuler, sinon le
  -- second aurait payé pour rien.
  select until into actuel from public.team_boosts where team = moi.team for update;
  fin := greatest(coalesce(actuel, now()), now()) + interval '2 hours';

  update public.players set gold = gold - prix where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -prix, 'achat : double LP pour l''équipe, 2 h');

  insert into public.team_boosts (team, until, bought_by, at)
  values (moi.team, fin, moi.id, now())
  on conflict (team) do update set until = excluded.until,
                                   bought_by = excluded.bought_by, at = now();

  return jsonb_build_object('boost_until', fin, 'team', moi.team,
                            'prix', prix, 'gold', moi.gold - prix);
end $$;


-- ---------------------------------------------------------------------
--  5. Changer d'équipe
--
--  On n'échange pas avec qui l'on veut : le tirage est fait ici, sous
--  verrou, et il est aveugle. Payer 25 000 or achète le droit de brasser
--  les cartes, pas celui de choisir sa cible.
-- ---------------------------------------------------------------------
create or replace function public.shop_swap_team()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; autre public.players; prix int := 25000; mon_equipe text;
begin
  select * into moi from public.players where claimed_by = auth.uid() for update;
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if moi.gold < prix then raise exception 'Il te manque % or', prix - moi.gold; end if;

  select * into autre from public.players
   where team <> moi.team order by random() limit 1 for update;
  if not found then raise exception 'Aucun joueur dans l''équipe adverse'; end if;

  update public.players set gold = gold - prix where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -prix, 'achat : changement d''équipe avec ' || autre.name);

  mon_equipe := moi.team;
  perform set_config('app.team_swap', 'on', true);   -- le temps de l'échange
  update public.players set team = autre.team where id = moi.id;
  update public.players set team = mon_equipe       where id = autre.id;
  perform set_config('app.team_swap', 'off', true);

  return jsonb_build_object('moi', moi.name, 'autre', autre.name,
                            'ma_nouvelle_equipe', autre.team, 'prix', prix);
end $$;


revoke all     on function public.shop_buy_boost() from public, anon;
revoke all     on function public.shop_swap_team() from public, anon;
grant  execute on function public.shop_buy_boost() to authenticated, service_role;
grant  execute on function public.shop_swap_team() to authenticated, service_role;

notify pgrst, 'reload schema';

select name, team, gold from public.players order by gold desc;
select * from public.team_boosts;
