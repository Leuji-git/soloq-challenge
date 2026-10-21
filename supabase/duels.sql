-- =====================================================================
--  duels.sql — l'Ultime Bataille devient une série de 1 contre 1
--
--  CE QUI CHANGE
--
--  Le 5 contre 5 laisse place à des DUELS EN ARAM, un contre un,
--  premier kill gagnant. On ne s'inscrit plus à un poste — il n'en
--  existe pas dans un duel — on dit seulement si l'on est DISPONIBLE
--  jeudi soir.
--
--  Le soir venu, un tirage apparie les disponibles de chaque camp et
--  attribue un champion à chaque duel. Le site le joue en roulette :
--  les deux adversaires d'abord, le champion ensuite.
--
--  L'ÉCART SE JOUE À LA MAJORITÉ DES DUELS. Le camp qui en remporte le
--  plus emporte tout l'enjeu ; trois victoires sur cinq valent les
--  cinq. Et l'enjeu reste taillé comme avant : si le camp en tête
--  perd, il garde la marge (150 LP par défaut), jamais moins.
--
--      Médiocres 4 — Pitoyables 1  →  l'écart tombe à 150
--      Médiocres 1 — Pitoyables 4  →  l'écart se creuse d'autant
--      égalité                     →  rien ne bouge
--
--  Ce script est autonome : il crée ce qui manque si bataille.sql n'a
--  pas été lancé, et transforme ce qui existe sinon. Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. L'ÉVÉNEMENT, ET LES DISPONIBILITÉS
-- ---------------------------------------------------------------------
create table if not exists public.bataille (
  id     int primary key default 1,
  quand  timestamptz not null,
  lot    int  not null default 1000,
  ouvert boolean not null default true,
  constraint bataille_une_seule check (id = 1)
);
alter table public.bataille add column if not exists marge int not null default 150;

insert into public.bataille (id, quand, marge, ouvert)
values (1, timestamptz '2026-10-22 21:00:00 Europe/Paris', 150, true)
on conflict (id) do nothing;

create table if not exists public.bataille_inscrits (
  player_id  text primary key references public.players(id) on delete cascade,
  team       text not null check (team in ('a','b')),
  role       text,
  titulaire  boolean not null default true,
  inscrit_le timestamptz not null default now()
);

/* Un duel n'a pas de poste. On desserre donc ce que l'inscription au
   5 contre 5 imposait : le poste devient facultatif, et deux joueurs
   du même camp peuvent évidemment être disponibles en même temps. */
alter table public.bataille_inscrits alter column role drop not null;
drop index if exists public.bataille_poste_titulaire;
alter table public.bataille_inscrits drop constraint if exists bataille_inscrits_role_check;


-- ---------------------------------------------------------------------
--  2. LES CHAMPIONS DU TIRAGE
--
--  La clé est celle de Riot — « MonkeyKing » pour Wukong — parce que
--  c'est elle qui donne l'icône. Le nom est ce qu'on lit.
-- ---------------------------------------------------------------------
create table if not exists public.bataille_champions (
  cle text primary key,
  nom text not null
);

insert into public.bataille_champions (cle, nom) values
  ('Aatrox','Aatrox'), ('Ahri','Ahri'), ('Akali','Akali'), ('Alistar','Alistar'),
  ('Amumu','Amumu'), ('Annie','Annie'), ('Ashe','Ashe'), ('Blitzcrank','Blitzcrank'),
  ('Brand','Brand'), ('Braum','Braum'), ('Caitlyn','Caitlyn'), ('Chogath','Cho''Gath'),
  ('Darius','Darius'), ('Diana','Diana'), ('DrMundo','Dr. Mundo'), ('Draven','Draven'),
  ('Ekko','Ekko'), ('Ezreal','Ezreal'), ('Fiora','Fiora'), ('Garen','Garen'),
  ('Gragas','Gragas'), ('Graves','Graves'), ('Heimerdinger','Heimerdinger'),
  ('Irelia','Irelia'), ('Janna','Janna'), ('Jax','Jax'), ('Jhin','Jhin'),
  ('Jinx','Jinx'), ('Karthus','Karthus'), ('Katarina','Katarina'), ('Kayn','Kayn'),
  ('Kled','Kled'), ('Leblanc','LeBlanc'), ('LeeSin','Lee Sin'), ('Leona','Leona'),
  ('Lux','Lux'), ('Malphite','Malphite'), ('Maokai','Maokai'), ('MasterYi','Maître Yi'),
  ('MissFortune','Miss Fortune'), ('MonkeyKing','Wukong'), ('Mordekaiser','Mordekaiser'),
  ('Morgana','Morgana'), ('Nasus','Nasus'), ('Nautilus','Nautilus'), ('Neeko','Neeko'),
  ('Nunu','Nunu et Willump'), ('Olaf','Olaf'), ('Orianna','Orianna'), ('Pantheon','Pantheon'),
  ('Poppy','Poppy'), ('Pyke','Pyke'), ('Rammus','Rammus'), ('Renekton','Renekton'),
  ('Riven','Riven'), ('Sett','Sett'), ('Shaco','Shaco'), ('Shen','Shen'),
  ('Singed','Singed'), ('Sion','Sion'), ('Sona','Sona'), ('Soraka','Soraka'),
  ('Swain','Swain'), ('Teemo','Teemo'), ('Thresh','Thresh'), ('Tristana','Tristana'),
  ('Tryndamere','Tryndamere'), ('Twitch','Twitch'), ('Udyr','Udyr'), ('Urgot','Urgot'),
  ('Vayne','Vayne'), ('Veigar','Veigar'), ('Vi','Vi'), ('Viego','Viego'),
  ('Volibear','Volibear'), ('Warwick','Warwick'), ('Xayah','Xayah'), ('Yasuo','Yasuo'),
  ('Yone','Yone'), ('Zed','Zed'), ('Ziggs','Ziggs'), ('Zyra','Zyra')
on conflict (cle) do update set nom = excluded.nom;


-- ---------------------------------------------------------------------
--  3. LES DUELS TIRÉS
-- ---------------------------------------------------------------------
create table if not exists public.bataille_duels (
  id       int primary key,
  joueur_a text not null references public.players(id) on delete cascade,
  joueur_b text not null references public.players(id) on delete cascade,
  champion text not null,
  gagnant  text check (gagnant in ('a','b')),
  tire_le  timestamptz not null default now()
);

alter table public.bataille_champions enable row level security;
alter table public.bataille_duels     enable row level security;
drop policy if exists bataille_champions_read on public.bataille_champions;
drop policy if exists bataille_duels_read     on public.bataille_duels;
create policy bataille_champions_read on public.bataille_champions for select to anon, authenticated using (true);
create policy bataille_duels_read     on public.bataille_duels     for select to anon, authenticated using (true);

do $$ begin
  alter publication supabase_realtime add table public.bataille_duels;
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
--  4. SE DÉCLARER DISPONIBLE
--
--  Aucun paramètre : on ne peut inscrire que soi, et que dans son camp.
--  L'équipe est lue sur la fiche du joueur, côté serveur — il n'existe
--  aucun chemin pour demander à jouer chez l'adversaire.
-- ---------------------------------------------------------------------
drop function if exists public.bataille_inscrire(text);

create or replace function public.bataille_inscrire()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players;
begin
  perform public.bataille_verifie();
  moi := public.bataille_moi();

  insert into public.bataille_inscrits (player_id, team, role, titulaire)
  values (moi.id, moi.team, null, true)
  on conflict (player_id) do update set team = excluded.team;

  return jsonb_build_object('equipe', moi.team, 'dispo', true);
end $$;

create or replace function public.bataille_desister()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players;
begin
  perform public.bataille_verifie();
  moi := public.bataille_moi();
  delete from public.bataille_inscrits where player_id = moi.id;
  return jsonb_build_object('dispo', false);
end $$;

revoke all     on function public.bataille_inscrire() from public, anon;
revoke all     on function public.bataille_desister() from public, anon;
grant  execute on function public.bataille_inscrire() to authenticated, service_role;
grant  execute on function public.bataille_desister() to authenticated, service_role;


-- ---------------------------------------------------------------------
--  5. LE TIRAGE
--
--  On apparie au hasard les disponibles des deux camps, et on donne un
--  champion à chaque duel. S'il y a plus de monde d'un côté, le surplus
--  reste sur le banc — et le tirage le dit.
--
--  Retirer efface les duels précédents : c'est un nouveau tirage, pas
--  un ajout. Les résultats déjà saisis partent avec, volontairement.
-- ---------------------------------------------------------------------
create or replace function public.bataille_tirer()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a text[]; b text[]; champs text[]; n int; i int;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;

  select array_agg(player_id order by random()) into a
    from public.bataille_inscrits where team = 'a';
  select array_agg(player_id order by random()) into b
    from public.bataille_inscrits where team = 'b';

  n := least(coalesce(array_length(a, 1), 0), coalesce(array_length(b, 1), 0));
  if n = 0 then
    raise exception 'Il faut au moins un joueur disponible dans chaque camp';
  end if;

  select array_agg(cle order by random()) into champs from public.bataille_champions;
  if coalesce(array_length(champs, 1), 0) < n then
    raise exception 'Pas assez de champions au tirage';
  end if;

  delete from public.bataille_duels;
  for i in 1..n loop
    insert into public.bataille_duels (id, joueur_a, joueur_b, champion)
    values (i, a[i], b[i], champs[i]);
  end loop;

  return jsonb_build_object('duels', n,
    'banc_a', coalesce(array_length(a, 1), 0) - n,
    'banc_b', coalesce(array_length(b, 1), 0) - n);
end $$;

-- Noter le vainqueur d'un duel. p_gagnant vaut 'a', 'b', ou null pour
-- effacer une saisie faite trop vite.
create or replace function public.bataille_marquer(p_duel int, p_gagnant text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if p_gagnant is not null and p_gagnant not in ('a','b') then
    raise exception 'Le vainqueur est « a », « b », ou rien';
  end if;
  update public.bataille_duels set gagnant = p_gagnant where id = p_duel;
  if not found then raise exception 'Duel % inconnu', p_duel; end if;
  return jsonb_build_object('duel', p_duel, 'gagnant', p_gagnant);
end $$;

revoke all     on function public.bataille_tirer()             from public, anon;
revoke all     on function public.bataille_marquer(int, text)  from public, anon;
grant  execute on function public.bataille_tirer()             to authenticated, service_role;
grant  execute on function public.bataille_marquer(int, text)  to authenticated, service_role;


-- ---------------------------------------------------------------------
--  6. LE RÉSULTAT
--
--  La majorité des duels emporte tout l'enjeu. L'ancienne version
--  prenait le vainqueur en paramètre ; celle-ci le lit dans les duels,
--  ce qui est moins discutable un soir de fin de challenge.
-- ---------------------------------------------------------------------
drop function if exists public.bataille_resoudre(text);

create or replace function public.bataille_resoudre()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  va int; vb int; gagnant text; perdant text;
  e jsonb; x int; camp text; signe int; i int;
  joueurs text[]; j text; part int; reste int; k int; n int := 0;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;

  select count(*) filter (where gagnant = 'a'), count(*) filter (where gagnant = 'b')
    into va, vb from public.bataille_duels;

  if va + vb = 0 then raise exception 'Aucun duel n''a encore de vainqueur'; end if;
  if va = vb then
    update public.bataille set ouvert = false where id = 1;
    return jsonb_build_object('egalite', true, 'a', va, 'b', vb, 'deplace', 0);
  end if;

  gagnant := case when va > vb then 'a' else 'b' end;
  perdant := case when gagnant = 'a' then 'b' else 'a' end;

  e := public.bataille_enjeu();
  x := (e->>'enjeu')::int;
  if x <= 0 then
    raise exception 'L''écart est déjà sous la marge : il n''y a rien à déplacer';
  end if;

  /* Deux passes : le camp gagnant encaisse, le perdant règle. Chacun
     partage entre CEUX QUI ONT DUELLÉ — pas les disponibles restés sur
     le banc — le reste de la division allant au premier. */
  for i in 1..2 loop
    if i = 1 then camp := gagnant; signe := 1;
    else           camp := perdant; signe := -1; end if;

    if camp = 'a' then
      select array_agg(joueur_a order by id) into joueurs from public.bataille_duels;
    else
      select array_agg(joueur_b order by id) into joueurs from public.bataille_duels;
    end if;
    continue when joueurs is null;

    part  := x / array_length(joueurs, 1);
    reste := x - part * array_length(joueurs, 1);
    k := 0;

    foreach j in array joueurs loop
      k := k + 1;
      insert into public.games (player_id, lp, lp_items, win, duo, kind,
                                match_id, played_on, created_at)
      values (j, 0, signe * (part + case when k = 1 then reste else 0 end),
              signe > 0, 'solo', 'bataille',
              'bataille-' || camp || '-' || j, current_date, now())
      on conflict do nothing;
      n := n + 1;
    end loop;
  end loop;

  update public.bataille set ouvert = false where id = 1;

  return jsonb_build_object('gagnant', gagnant, 'perdant', perdant,
                            'a', va, 'b', vb, 'enjeu', x,
                            'deplace', x * 2, 'lignes', n);
end $$;

revoke all     on function public.bataille_resoudre() from public, anon;
grant  execute on function public.bataille_resoudre() to authenticated, service_role;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
--  Vérification
-- ---------------------------------------------------------------------
select quand at time zone 'Europe/Paris' as le_soir_dit, marge, ouvert
  from public.bataille where id = 1;

select i.team, p.name, i.inscrit_le
  from public.bataille_inscrits i join public.players p on p.id = i.player_id
 order by i.team, i.inscrit_le;

select d.id, pa.name as mediocre, pb.name as pitoyable, c.nom as champion, d.gagnant
  from public.bataille_duels d
  join public.players pa on pa.id = d.joueur_a
  join public.players pb on pb.id = d.joueur_b
  left join public.bataille_champions c on c.cle = d.champion
 order by d.id;

select count(*) as champions_au_tirage from public.bataille_champions;
select public.bataille_enjeu() as enjeu_du_moment;
