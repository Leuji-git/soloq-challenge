-- =====================================================================
--  NETTOYAGE DES PSEUDOS ET TAGS
--  À coller dans Supabase > SQL Editor > Run. Idempotent.
--
--  Un Riot ID copié depuis Discord embarque des caractères de contrôle
--  bidirectionnels invisibles (U+2066 à U+2069, U+200B…). Ils ne se voient
--  pas, mais ils cassent le lien dpm.lol (« LEUJI-OIOIO%E2%81%A9 ») et
--  empêchent Riot de retrouver le compte.
--
--  Ce script les retire des fiches existantes, puis pose un trigger pour
--  qu'ils ne puissent plus jamais entrer en base, quel que soit le chemin :
--  inscription, console admin, fonction Riot ou SQL.
-- =====================================================================

-- translate() supprime tout caractère de la 2e liste sans équivalent dans
-- la 3e. Plus sûr qu'une expression régulière pour des codes Unicode.
create or replace function public.clean_riot_text(v text)
returns text language sql immutable as $$
  select btrim(translate(coalesce(v, ''),
    U&'\200B\200C\200D\200E\200F\202A\202B\202C\202D\202E\2060\2061\2062\2063\2064\2066\2067\2068\2069\FEFF',
    ''));
$$;

create or replace function public.players_clean_text()
returns trigger language plpgsql as $$
begin
  new.name := public.clean_riot_text(new.name);
  new.tag  := public.clean_riot_text(new.tag);
  return new;
end $$;

drop trigger if exists t_players_clean_text on public.players;
create trigger t_players_clean_text
  before insert or update on public.players
  for each row execute function public.players_clean_text();

-- Nettoie les fiches déjà en base : la simple réécriture déclenche le trigger.
update public.players
   set name = name, tag = tag
 where name <> public.clean_riot_text(name)
    or tag  <> public.clean_riot_text(tag);

-- Vérification : doit renvoyer 0.
select count(*) as fiches_encore_sales
  from public.players
 where name <> public.clean_riot_text(name)
    or tag  <> public.clean_riot_text(tag);
