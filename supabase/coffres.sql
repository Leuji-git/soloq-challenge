-- =====================================================================
--  coffres.sql — on loote des coffres, plus des objets
--
--  Une victoire fait désormais tomber un COFFRE. L'objet n'existe pas
--  encore : il est tiré au moment où le joueur ouvre.
--
--  C'est le point important. Si le contenu était décidé au loot, il
--  dormirait en base — et la table est en lecture publique, donc
--  n'importe qui pourrait savoir ce qu'il y a dedans avant de
--  l'ouvrir. En tirant à l'ouverture, il n'y a rien à espionner.
--
--  Les objets déjà obtenus ne bougent pas : les coffres s'ajoutent à
--  partir de maintenant.
--
--  À lancer après objets-effets.sql. Idempotent.
-- =====================================================================

create table if not exists public.player_boxes (
  id           uuid primary key default gen_random_uuid(),
  player_id    text not null references public.players(id) on delete cascade,
  source_match text,
  obtained_at  timestamptz not null default now(),
  opened_at    timestamptz,
  item_key     text references public.items(key) on delete set null
);
create index if not exists player_boxes_idx on public.player_boxes (player_id, opened_at);
-- Un coffre par partie : un relevé rejoué n'en fabrique pas deux.
create unique index if not exists player_boxes_source_key
  on public.player_boxes (player_id, source_match) where source_match is not null;

alter table public.player_boxes enable row level security;
drop policy if exists boxes_read on public.player_boxes;
-- Lecture publique : voir qu'un adversaire a trois coffres en attente
-- fait partie du jeu. Le contenu, lui, n'existe pas encore.
create policy boxes_read on public.player_boxes
  for select to anon, authenticated using (true);

do $$ begin
  begin execute 'alter publication supabase_realtime add table public.player_boxes';
  exception when duplicate_object then null; end;
end $$;


-- ---------------------------------------------------------------------
--  Ouvrir un coffre
--
--  Le plus ancien d'abord. Le tirage se fait ICI, côté serveur : le
--  navigateur ne choisit rien et ne peut pas relancer les dés.
-- ---------------------------------------------------------------------
create or replace function public.open_box()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; boite public.player_boxes; cle text; it public.items;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;

  -- for update skip locked : deux clics simultanés ouvrent deux coffres
  -- différents, jamais le même deux fois.
  select * into boite from public.player_boxes
   where player_id = moi.id and opened_at is null
   order by obtained_at limit 1
   for update skip locked;
  if not found then raise exception 'Tu n''as aucun coffre à ouvrir'; end if;

  cle := public.draw_item();
  if cle is null then raise exception 'Aucun objet actif dans le catalogue'; end if;

  update public.player_boxes set opened_at = now(), item_key = cle where id = boite.id;

  insert into public.player_items (player_id, item_key, source_match)
  values (moi.id, cle, 'box-' || boite.id);

  select * into it from public.items where key = cle;
  return jsonb_build_object(
    'key', it.key, 'name', it.name, 'icon', it.icon,
    'rarity', it.rarity, 'target', it.target, 'effect', it.effect,
    'restants', (select count(*) from public.player_boxes
                  where player_id = moi.id and opened_at is null));
end $$;

revoke all     on function public.open_box() from public, anon;
grant  execute on function public.open_box() to authenticated, service_role;

notify pgrst, 'reload schema';

select p.name,
       count(*) filter (where b.opened_at is null) as coffres_en_attente,
       count(*) filter (where b.opened_at is not null) as deja_ouverts
  from public.players p
  left join public.player_boxes b on b.player_id = p.id
 group by p.name order by 2 desc;
