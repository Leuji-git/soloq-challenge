-- =====================================================================
--  CORRECTIF — à coller dans Supabase > SQL Editor > Run.
--
--  Problème : dans le SQL Editor tu n'es pas un utilisateur connecté mais
--  le rôle `postgres`. `auth.uid()` y vaut donc NULL, `is_admin()` renvoie
--  false, et mes triggers refusaient tes propres requêtes.
--
--  Correctif : quand `auth.uid()` est NULL, la requête ne vient pas du
--  navigateur — elle vient du SQL Editor, d'une migration ou de la clé
--  `service_role`. On la laisse passer.
--
--  Ce n'est PAS un trou de sécurité : un visiteur non connecté a lui aussi
--  `auth.uid()` NULL, mais les policies RLS sont déclarées `to authenticated`
--  et le bloquent AVANT que le trigger ne s'exécute. Le trigger n'est donc
--  jamais atteint par un anonyme venant du site.
-- =====================================================================

create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- SQL Editor / service_role

  if new.is_admin is distinct from old.is_admin and not public.is_admin() then
    raise exception 'Seul un administrateur peut modifier ce droit';
  end if;
  new.id := old.id;
  return new;
end $$;

create or replace function public.guard_player_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- SQL Editor / service_role
  if public.is_admin() then return new; end if;

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

-- ---------------------------------------------------------------------
--  Les deux mises à jour qui étaient bloquées
-- ---------------------------------------------------------------------
update public.players   set name = 'Metaxou', tag = 'Meta' where id = 'maxou';
update public.challenge set start_date = '2026-10-01'       where id = 1;

-- ---------------------------------------------------------------------
--  Te donner les droits d'administration (indispensable pour la console).
--  Lance d'abord la première ligne pour repérer ton identifiant, puis
--  décommente la seconde en y collant ton uuid.
-- ---------------------------------------------------------------------
select id, display_name, is_admin from public.profiles;
-- update public.profiles set is_admin = true where id = 'colle-ton-uuid-ici';
