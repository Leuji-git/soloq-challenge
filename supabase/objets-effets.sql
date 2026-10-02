-- =====================================================================
--  objets-effets.sql — verrouiller un objet, et le voir agir
--
--  Un objet se verrouille AVANT une partie : sur soi (bonus) ou sur un
--  adversaire (malus). Il se consomme sur la partie suivante du joueur
--  visé, que sa condition soit remplie ou non.
--
--  Le classement général ne bouge pas : il reste sur `games.lp`, le LP
--  net rendu par Riot. Les objets vivent dans `games.lp_items`, à côté,
--  et ne changent que l'affichage de la partie.
--
--  À lancer après items.sql. Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. Les colonnes
-- ---------------------------------------------------------------------
-- locked_at : l'heure du verrouillage. Une partie ne peut consommer un
-- objet que si elle a commencé APRÈS, sinon on pourrait armer un objet
-- en connaissant déjà le résultat.
alter table public.player_items add column if not exists locked_at     timestamptz;
alter table public.player_items add column if not exists applied_match text;
alter table public.player_items add column if not exists lp_effect     int;
alter table public.player_items add column if not exists note          text;

-- Les LP des objets, toujours séparés du net.
alter table public.games add column if not exists lp_items int not null default 0;

do $$ begin
  alter table public.games add constraint games_lp_items_range check (lp_items between -200 and 200);
exception when duplicate_object then null; end $$;

create index if not exists player_items_armed_idx
  on public.player_items (target_id, locked_at) where used_at is null and locked_at is not null;


-- ---------------------------------------------------------------------
--  2. Verrouiller un objet
--     Les règles sont ici et pas dans la page : une requête forgée
--     depuis la console du navigateur se heurte aux mêmes refus.
-- ---------------------------------------------------------------------
create or replace function public.lock_item(p_item uuid, p_target text)
returns public.player_items language plpgsql security definer set search_path = public as $$
declare it public.player_items; cible public.players; moi public.players; genre text;
begin
  select * into it from public.player_items where id = p_item;
  if not found then raise exception 'Objet introuvable'; end if;

  select * into moi from public.players where id = it.player_id;

  -- Propriétaire, ou administrateur (bac à sable). auth.uid() est null
  -- dans l'éditeur SQL : on l'y laisse passer.
  if auth.uid() is not null
     and moi.claimed_by is distinct from auth.uid()
     and not public.is_admin() then
    raise exception 'Cet objet ne t''appartient pas';
  end if;

  if it.used_at is not null then raise exception 'Cet objet a déjà été consommé'; end if;

  select * into cible from public.players where id = p_target;
  if not found then raise exception 'Joueur visé introuvable'; end if;

  select target into genre from public.items where key = it.item_key;
  if genre = 'soi' and cible.id <> moi.id then
    raise exception 'Ce bonus ne peut se poser que sur toi';
  end if;
  if genre = 'adversaire' and cible.team = moi.team then
    raise exception 'Ce malus ne se pose que sur un adversaire';
  end if;

  update public.player_items
     set locked_at = now(), target_id = p_target
   where id = p_item
  returning * into it;
  return it;
end $$;


-- ---------------------------------------------------------------------
--  3. Déverrouiller, tant que la partie n'a pas eu lieu
-- ---------------------------------------------------------------------
create or replace function public.unlock_item(p_item uuid)
returns public.player_items language plpgsql security definer set search_path = public as $$
declare it public.player_items; moi public.players;
begin
  select * into it from public.player_items where id = p_item;
  if not found then raise exception 'Objet introuvable'; end if;

  select * into moi from public.players where id = it.player_id;
  if auth.uid() is not null
     and moi.claimed_by is distinct from auth.uid()
     and not public.is_admin() then
    raise exception 'Cet objet ne t''appartient pas';
  end if;
  if it.used_at is not null then raise exception 'Trop tard : l''objet a déjà agi'; end if;

  update public.player_items
     set locked_at = null, target_id = null
   where id = p_item
  returning * into it;
  return it;
end $$;


revoke all     on function public.lock_item(uuid, text) from public, anon;
revoke all     on function public.unlock_item(uuid)     from public, anon;
grant  execute on function public.lock_item(uuid, text) to authenticated, service_role;
grant  execute on function public.unlock_item(uuid)     to authenticated, service_role;


-- ---------------------------------------------------------------------
--  4. Les effets, réécrits pour coller à ce que le code fait vraiment
--
--  L'ancien texte promettait d'attendre le bon moment (« ta prochaine
--  défaite … »). Le modèle retenu est autre : on verrouille avant une
--  partie, et l'objet se consomme sur celle-là. Le texte doit dire la
--  vérité, sinon personne ne comprend son récap.
--
--  Toute modification ici doit être reportée dans EFFETS, dans
--  supabase/functions/riot/index.ts. C'est le code qui calcule.
-- ---------------------------------------------------------------------
update public.items set effect = v.effect from (values
  ('pierre_garde',      'Si tu perds cette partie, elle ne te coûte aucun LP.'),
  ('bottes_celerite',   'Si tu gagnes cette partie en moins de 25 minutes : +20 LP.'),
  ('larme_deesse',      '+5 LP sur cette partie, quoi qu''il arrive.'),
  ('elixir_rage',       'Si tu gagnes cette partie, ton gain est doublé.'),
  ('ange_gardien',      'Si tu perds cette partie, tu ne perds que la moitié des LP.'),
  ('baron_nashor',      'Si tu gagnes cette partie : +25 LP.'),
  ('marque_chasseur',   'Si ta cible meurt 5 fois ou plus dans sa prochaine partie : −20 LP.'),
  ('isolement',         'Si ta cible joue sa prochaine partie en duo : −15 LP.'),
  ('brouillard',        'Si le score de vision de ta cible est sous 15 : −15 LP.'),
  ('poids_monde',       'Si ta cible gagne sa prochaine partie, elle n''en touche que la moitié.'),
  ('peage',             'Si ta cible gagne sa prochaine partie, ses 20 premiers LP s''évaporent.'),
  ('malediction_nexus', 'Si ta cible perd sa prochaine partie, elle perd le double.'),
  ('amnesie',           'Si ta cible rejoue un champion déjà joué pendant le challenge : −25 LP.'),
  ('pile_ou_face',      'Sur la prochaine partie de ta cible : +30 LP si elle gagne, −30 si elle perd.')
) as v(key, effect) where public.items.key = v.key;


-- ---------------------------------------------------------------------
--  5. Le bac à sable : la simulation passe désormais par la fonction
--     « riot », qui porte le moteur d'effets. On retire la version SQL
--     pour ne pas avoir deux vérités qui divergent.
-- ---------------------------------------------------------------------
drop function if exists public.admin_sim_game(text, int, boolean, text);

-- admin_clear_sim doit aussi rendre les objets consommés par une
-- simulation, sinon un test laisse des inventaires faussés.
create or replace function public.admin_clear_sim()
returns jsonb language plpgsql security definer set search_path = public as $$
declare ng int; ni int; nr int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Réservé à un administrateur';
  end if;

  -- Les objets rendus : consommés par une partie simulée, ils
  -- retournent en réserve, déverrouillés.
  update public.player_items
     set used_at = null, applied_match = null, lp_effect = null, note = null,
         locked_at = null, target_id = null
   where applied_match like 'sim-%';
  get diagnostics nr = row_count;

  delete from public.player_items where source_match like 'sim-%';
  get diagnostics ni = row_count;
  delete from public.games where match_id like 'sim-%';
  get diagnostics ng = row_count;
  return jsonb_build_object('parties', ng, 'objets', ni, 'rendus', nr);
end $$;

revoke all     on function public.admin_clear_sim() from public, anon;
grant  execute on function public.admin_clear_sim() to authenticated, service_role;


select key, target, effect from public.items order by target, sort;
