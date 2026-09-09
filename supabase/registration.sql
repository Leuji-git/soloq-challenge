-- =====================================================================
--  INSCRIPTION AUTO-SERVICE + TIRAGE D'ÉQUIPE
--  À coller dans Supabase > SQL Editor > Run. Idempotent.
--
--  Avant : 8 profils créés d'avance, chacun en réclamait un.
--  Après : chacun crée le sien à la première connexion (pseudo Riot,
--          rang, LP) et l'équipe lui est attribuée par la BASE.
--
--  Le tirage est fait côté serveur volontairement : la roulette du site
--  ne fait que RÉVÉLER le résultat. Un joueur qui trafiquerait le
--  JavaScript ne peut pas choisir son camp.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Chacun peut créer SON profil joueur (et un seul :
--    `players.claimed_by` porte déjà une contrainte UNIQUE).
-- ---------------------------------------------------------------------
drop policy if exists players_insert on public.players;
create policy players_insert on public.players for insert to authenticated
  with check (public.is_admin() or claimed_by = auth.uid());

-- ---------------------------------------------------------------------
-- 2. L'équipe est décidée par la base, jamais par le client.
--    Équipes déséquilibrées -> on complète la plus petite.
--    Équipes à égalité      -> tirage au sort.
--    Ainsi le hasard reste réel sans jamais produire un 6 contre 2.
-- ---------------------------------------------------------------------
create or replace function public.assign_team()
returns trigger language plpgsql security definer set search_path = public as $$
declare na int; nb int;
begin
  if auth.uid() is null then return new; end if;   -- seed / SQL Editor
  if public.is_admin() then return new; end if;    -- la console garde la main

  select count(*) filter (where team = 'a'),
         count(*) filter (where team = 'b')
    into na, nb
    from public.players;

  if    na < nb then new.team := 'a';
  elsif nb < na then new.team := 'b';
  else               new.team := case when random() < 0.5 then 'a' else 'b' end;
  end if;

  return new;
end $$;

drop trigger if exists t_assign_team on public.players;
create trigger t_assign_team
  before insert on public.players
  for each row execute function public.assign_team();

-- ---------------------------------------------------------------------
-- 3. Un joueur peut modifier SON profil (rang de départ, pseudo Riot),
--    mais toujours pas celui des autres, ni son équipe.
-- ---------------------------------------------------------------------
create or replace function public.guard_player_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- SQL Editor / service_role
  if public.is_admin() then return new; end if;

  -- Réclamer un profil libre, ou libérer le sien.
  if row(new.name, new.tag, new.team, new.seed_score, new.sort)
     is not distinct from
     row(old.name, old.tag, old.team, old.seed_score, old.sort) then
    if (old.claimed_by is null      and new.claimed_by = auth.uid())
    or (old.claimed_by = auth.uid() and new.claimed_by is null) then
      return new;
    end if;
  end if;

  -- Modifier son propre profil : tout sauf l'équipe et le propriétaire.
  if old.claimed_by = auth.uid() then
    if new.team is distinct from old.team then
      raise exception 'Ton équipe a été tirée au sort, elle ne se change pas';
    end if;
    if new.claimed_by is distinct from old.claimed_by then
      raise exception 'Ce profil ne peut pas changer de propriétaire';
    end if;
    return new;
  end if;

  raise exception 'Ce profil joueur appartient à quelqu''un d''autre';
end $$;

-- ---------------------------------------------------------------------
-- 4. Nettoyage des 8 profils créés d'avance.
--    Ils font doublon maintenant que chacun s'inscrit lui-même.
--    DÉCOMMENTE cette ligne quand tu es prêt à repartir de zéro
--    (elle supprime aussi les parties rattachées à ces profils).
-- ---------------------------------------------------------------------
-- delete from public.players where claimed_by is null;

select id, name, tag, team, claimed_by from public.players order by sort;
