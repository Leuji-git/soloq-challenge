-- =====================================================================
--  economie.sql — l'or, et la boutique
--
--  Chaque partie relevée rapporte de l'or, selon le poste joué et ce
--  qu'on y a fait. Le barème vit dans la fonction « riot »
--  (OR_ROLES / orDeLaPartie) : c'est elle qui calcule, la base ne fait
--  qu'enregistrer.
--
--  Deux choses s'achètent :
--    * un objet DÉJÀ DÉCOUVERT — on n'achète pas une surprise ;
--    * des LP fictifs, très chers, qui ne comptent QUE dans le total
--      global. Le classement individuel reste du pur LP Riot : l'or ne
--      doit permettre à personne de doubler quelqu'un au tableau.
--
--  À lancer après objets-effets.sql. Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. Le pécule et son journal
-- ---------------------------------------------------------------------
alter table public.players add column if not exists gold int not null default 0;

do $$ begin
  alter table public.players add constraint players_gold_positif check (gold >= 0);
exception when duplicate_object then null; end $$;

-- Tout mouvement d'or laisse une trace. Personne ne peut écrire ici
-- depuis le navigateur : c'est ce qui rend le solde vérifiable.
create table if not exists public.gold_ledger (
  id        bigserial primary key,
  player_id text        not null references public.players(id) on delete cascade,
  delta     int         not null,
  raison    text        not null,
  match_id  text,
  at        timestamptz not null default now()
);
create index if not exists gold_ledger_idx on public.gold_ledger (player_id, at desc);
-- Une partie ne crédite qu'une fois, même si un relevé repasse dessus.
create unique index if not exists gold_ledger_match_key
  on public.gold_ledger (player_id, match_id) where match_id is not null;

alter table public.gold_ledger enable row level security;
drop policy if exists gold_ledger_read on public.gold_ledger;
create policy gold_ledger_read on public.gold_ledger
  for select to anon, authenticated using (true);


-- ---------------------------------------------------------------------
--  2. Les statistiques de partie qui nourrissent l'or
-- ---------------------------------------------------------------------
alter table public.games add column if not exists role      text;
alter table public.games add column if not exists kills     int;
alter table public.games add column if not exists deaths    int;
alter table public.games add column if not exists assists   int;
alter table public.games add column if not exists vision    int;
alter table public.games add column if not exists dragons   int;
alter table public.games add column if not exists barons    int;
alter table public.games add column if not exists cs        int;
alter table public.games add column if not exists gold_gagne int;

-- Un achat de LP s'enregistre comme une ligne de partie d'un genre à
-- part : lp = 0 (le net ne bouge pas), lp_items = les LP achetés (le
-- total global les prend). Rien d'autre à câbler, le calcul existant
-- les ramasse tout seul.
alter table public.games drop constraint if exists games_kind_valid;
do $$ begin
  alter table public.games add constraint games_kind_valid check (kind in ('game','adjust','shop'));
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
--  2 bis. Deux objets liés à l'économie et au contre
--
--  Ils sortent du barème en LP : l'un déplace de l'or, l'autre annule
--  les malus. Leur calcul vit dans la fonction « riot » (VOLEURS et
--  BOUCLIERS) ; ici on ne pose que la fiche.
-- ---------------------------------------------------------------------
insert into public.items (key, name, icon, rarity, target, teaser, effect, sort) values

  ('bourse_coupee', 'Bourse Coupée', '🪙', 'rare', 'adversaire',
   'On dit qu''elle s''ouvre toute seule quand son porteur trébuche.',
   'Si ta cible perd sa prochaine partie, tu lui prends 150 or.', 18),

  ('egide_contre', 'Égide du Contre', '🛡️', 'rare', 'soi',
   'Elle ne protège que ceux qui vont au bout.',
   'Si tu gagnes cette partie, tous les malus posés sur toi sont annulés. Si tu perds, elle ne sert à rien.', 7)

on conflict (key) do update set
  name = excluded.name, icon = excluded.icon, rarity = excluded.rarity,
  target = excluded.target, teaser = excluded.teaser, effect = excluded.effect,
  sort = excluded.sort;


-- ---------------------------------------------------------------------
--  3. Le prix des objets
-- ---------------------------------------------------------------------
alter table public.items add column if not exists price int;

update public.items set price = case rarity
  when 'commun'     then 350
  when 'rare'       then 800
  when 'legendaire' then 1800
  else 500 end
where price is null;


-- ---------------------------------------------------------------------
--  4. Créditer l'or — réservé au serveur
-- ---------------------------------------------------------------------
create or replace function public.credit_gold(
  p_player text, p_amount int, p_raison text, p_match text default null)
returns int language plpgsql security definer set search_path = public as $$
declare solde int;
begin
  if p_amount is null or p_amount = 0 then
    select gold into solde from public.players where id = p_player;
    return coalesce(solde, 0);
  end if;

  -- L'index unique sur (player_id, match_id) empêche de créditer deux
  -- fois la même partie : on absorbe le conflit sans faire échouer le
  -- relevé entier.
  begin
    insert into public.gold_ledger (player_id, delta, raison, match_id)
    values (p_player, p_amount, p_raison, p_match);
  exception when unique_violation then
    select gold into solde from public.players where id = p_player;
    return coalesce(solde, 0);
  end;

  update public.players set gold = greatest(0, gold + p_amount)
   where id = p_player returning gold into solde;
  return coalesce(solde, 0);
end $$;

revoke all     on function public.credit_gold(text, int, text, text) from public, anon, authenticated;
grant  execute on function public.credit_gold(text, int, text, text) to service_role;


-- ---------------------------------------------------------------------
--  5. La boutique
--     Les règles sont ICI, pas dans la page : une requête forgée depuis
--     la console du navigateur se heurte aux mêmes refus.
-- ---------------------------------------------------------------------
create or replace function public.shop_buy_item(p_item text)
returns public.player_items language plpgsql security definer set search_path = public as $$
declare moi public.players; it public.items; ligne public.player_items;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;

  select * into it from public.items where key = p_item and active;
  if not found then raise exception 'Objet inconnu ou retiré du catalogue'; end if;

  -- On n'achète pas une surprise : il faut l'avoir déjà décroché une fois.
  if not exists (select 1 from public.player_items
                  where player_id = moi.id and item_key = p_item) then
    raise exception 'Tu ne peux acheter qu''un objet que tu as déjà obtenu en jeu';
  end if;

  if moi.gold < coalesce(it.price, 0) then
    raise exception 'Il te manque % or', coalesce(it.price,0) - moi.gold;
  end if;

  update public.players set gold = gold - it.price where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -it.price, 'achat : ' || it.name);

  insert into public.player_items (player_id, item_key, source_match)
  values (moi.id, p_item, 'shop-' || gen_random_uuid())
  returning * into ligne;
  return ligne;
end $$;


-- Les LP fictifs. Très chers, et ils ne touchent que le total global.
create or replace function public.shop_buy_lp(p_lp int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix int;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;

  prix := case p_lp when 10 then 2000 when 25 then 4500 when 50 then 8500 else null end;
  if prix is null then raise exception 'Lot invalide : 10, 25 ou 50 LP'; end if;
  if moi.gold < prix then raise exception 'Il te manque % or', prix - moi.gold; end if;

  update public.players set gold = gold - prix where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -prix, 'achat : ' || p_lp || ' LP');

  -- lp = 0 : le classement individuel ne bouge pas.
  -- lp_items = p_lp : le total global, lui, les prend.
  insert into public.games (player_id, lp, lp_items, win, duo, kind, match_id, played_on, created_by)
  values (moi.id, 0, p_lp, true, 'solo', 'shop',
          'shop-' || gen_random_uuid(), current_date, auth.uid());

  return jsonb_build_object('lp', p_lp, 'prix', prix, 'gold', moi.gold - prix);
end $$;

revoke all     on function public.shop_buy_item(text) from public, anon;
revoke all     on function public.shop_buy_lp(int)    from public, anon;
grant  execute on function public.shop_buy_item(text) to authenticated, service_role;
grant  execute on function public.shop_buy_lp(int)    to authenticated, service_role;


do $$ begin
  begin execute 'alter publication supabase_realtime add table public.gold_ledger';
  exception when duplicate_object then null; end;
end $$;

notify pgrst, 'reload schema';

-- Les taux de drop se recalculent tout seuls : le site les lit du
-- catalogue. Avec deux rares de plus, un commun passe de 11,1 % à 10 %.
select rarity, count(*) as objets, min(price) as prix from public.items
 where active group by rarity order by min(price);

select id, name, gold from public.players order by gold desc;
