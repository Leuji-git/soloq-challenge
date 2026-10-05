-- =====================================================================
--  roles.sql — chacun déclare ses postes
--
--  Le poste joué est bien dans les parties relevées (games.role), mais
--  c'est le poste du jeu, pas celui qu'on revendique : une partie en
--  autofill support ne fait pas de toi un support. On laisse donc
--  chacun déclarer le sien, principal et secondaire.
--
--  Deux colonnes sur le joueur, et rien de plus : pas de table, pas de
--  jointure. Un joueur a un poste principal et un secondaire, c'est
--  tout ce que le classement affiche.
--
--  Qui écrit : le propriétaire du profil, et lui seul. La policy
--  players_update limite déjà chacun à sa propre ligne, et le
--  déclencheur guard_player_update laisse passer une écriture qui ne
--  touche pas à l'identité.
--
--  À lancer après schema.sql. Idempotent.
-- =====================================================================

alter table public.players add column if not exists role_main   text;
alter table public.players add column if not exists role_second text;

do $$ begin
  alter table public.players add constraint players_role_main_valid
    check (role_main is null or role_main in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.players add constraint players_role_second_valid
    check (role_second is null or role_second in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY'));
exception when duplicate_object then null; end $$;

-- Le même poste ne peut pas être principal ET secondaire : ce serait
-- afficher deux fois la même icône pour ne rien dire de plus.
do $$ begin
  alter table public.players add constraint players_roles_distincts
    check (role_second is null or role_main is null or role_second <> role_main);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';

select name, coalesce(role_main, '—') as principal,
       coalesce(role_second, '—') as secondaire
  from public.players
 where alias_of is null
 order by sort, name;
