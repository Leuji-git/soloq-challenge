-- =====================================================================
--  second-compte.sql — un joueur, deux comptes LoL
--
--  Tankiste joue aussi sur rottensteer50. Ses parties doivent compter
--  pour Tankiste, pas pour un douzième concurrent.
--
--  Le choix retenu : une LIGNE JOUEUR à part, avec son propre puuid et
--  son propre relevé de rang, qui pointe vers le joueur qu'elle double.
--
--  Pourquoi pas une deuxième colonne « puuid » sur le joueur ? Parce
--  que les LP se déduisent de l'écart entre deux relevés de rang, et
--  qu'un compte a sa propre échelle : Or III sur l'un et Fer II sur
--  l'autre, ce sont deux compteurs qui n'ont rien à voir l'un avec
--  l'autre. En gardant une ligne par compte, chaque échelle garde son
--  relevé — et seule l'ÉCRITURE est redirigée vers le joueur : les
--  parties, l'or, les coffres et les objets atterrissent chez lui.
--
--  La ligne doublure n'apparaît jamais sur le site : elle n'a aucune
--  partie à elle, elles sont toutes au nom du joueur.
--
--  À lancer après riot-api.sql. Idempotent.
-- =====================================================================

alter table public.players add column if not exists alias_of text
  references public.players(id) on delete cascade;

create index if not exists players_alias_idx on public.players (alias_of)
  where alias_of is not null;

do $$ begin
  alter table public.players add constraint players_alias_not_self
    check (alias_of is null or alias_of <> id);
exception when duplicate_object then null; end $$;

-- Un second compte ne se réclame pas : il n'a pas de propriétaire à
-- lui, il appartient au joueur qu'il double. Sans ce garde-fou, il
-- resterait un profil libre que n'importe qui pourrait prendre.
create or replace function public.guard_alias_claim()
returns trigger language plpgsql as $$
begin
  if new.alias_of is not null and new.claimed_by is not null then
    raise exception 'Ce compte est le second compte d''un joueur : il ne se réclame pas';
  end if;
  return new;
end $$;

drop trigger if exists guard_alias_claim on public.players;
create trigger guard_alias_claim
  before insert or update on public.players
  for each row execute function public.guard_alias_claim();


-- ---------------------------------------------------------------------
--  Le second compte de Tankiste
--
--  Le puuid reste vide : le prochain relevé retrouve le compte à partir
--  du pseudo et du tag, et pose le premier relevé de rang tout seul.
--  C'est le même chemin que pour un profil créé avant le suivi
--  automatique, déjà en place dans la fonction.
-- ---------------------------------------------------------------------
insert into public.players (id, name, tag, team, seed_score, sort, alias_of)
select 'rottensteer50-euw', 'rottensteer50', 'EUW', t.team, 0, 900, t.id
  from public.players t
 where t.id = 'tankiste-euw'
on conflict (id) do update
  set alias_of = excluded.alias_of,
      team     = excluded.team;

notify pgrst, 'reload schema';

select p.id, p.name, p.tag, p.team,
       p.alias_of as double_de,
       (p.puuid is not null) as rattache_a_riot
  from public.players p
 where p.alias_of is not null or p.id = 'tankiste-euw'
 order by p.alias_of nulls first;
