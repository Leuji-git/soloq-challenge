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
--  LES CAMPS N'ONT PAS BESOIN D'ÊTRE ÉGAUX. À trois contre quatre, on
--  joue quatre duels et quelqu'un du camp le plus mince remonte sur le
--  ring — tiré au sort comme le reste. Personne ne reste sur le banc :
--  mettre un joueur de côté le soir de la finale serait la pire façon
--  de régler une histoire de parité.
--
--  L'ÉCART SE JOUE À LA MAJORITÉ DES DUELS. Le camp qui en remporte le
--  plus emporte tout l'enjeu ; trois victoires sur cinq valent les
--  cinq. Et l'enjeu reste taillé comme avant : si le camp en tête
--  perd, il garde la marge (150 LP par défaut), jamais moins.
--
--      Médiocres 4 — Pitoyables 1  →  l'écart tombe à 150
--      Médiocres 1 — Pitoyables 4  →  l'écart se creuse d'autant
--      égalité 2 — 2               →  ON REJOUE
--
--  Une égalité ne décide rien : on tire une MANCHE de plus, et autant
--  qu'il en faudra. Seule la dernière manche compte — celle qui aura
--  fini par départager les deux camps.
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
  manche   int not null default 1,
  joueur_a text not null references public.players(id) on delete cascade,
  joueur_b text not null references public.players(id) on delete cascade,
  champion text not null,
  gagnant  text check (gagnant in ('a','b')),
  tire_le  timestamptz not null default now()
);

alter table public.bataille_duels add column if not exists manche int not null default 1;

alter table public.bataille_champions enable row level security;
alter table public.bataille_duels     enable row level security;
drop policy if exists bataille_champions_read on public.bataille_champions;
drop policy if exists bataille_duels_read     on public.bataille_duels;
create policy bataille_champions_read on public.bataille_champions for select to anon, authenticated using (true);
create policy bataille_duels_read     on public.bataille_duels     for select to anon, authenticated using (true);

do $$ begin
  alter publication supabase_realtime add table public.bataille_duels;
exception when duplicate_object then null; end $$;


-- La manche en cours : la dernière tirée, ou zéro si rien n'est tiré.
create or replace function public.bataille_manche()
returns int language sql stable security definer set search_path = public as $$
  select coalesce(max(manche), 0) from public.bataille_duels;
$$;
grant execute on function public.bataille_manche() to anon, authenticated;


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
--  On apparie au hasard les disponibles des deux camps. Le nombre de
--  duels est celui du camp le PLUS FOURNI : le camp le plus mince
--  recycle alors ses joueurs dans l'ordre du tirage, si bien que le
--  premier d'entre eux — tiré au hasard comme les autres — joue deux
--  fois. Trois contre quatre donne donc quatre duels, pas trois.
--
--  Tant que la manche en cours n'a AUCUN résultat, retirer la refait :
--  c'est le cas du tirage qu'on veut recommencer. Dès qu'un vainqueur
--  est noté, tirer ouvre la MANCHE SUIVANTE et conserve la précédente.
--  Une seule commande, et elle fait ce qu'on attend d'elle aux deux
--  moments où on l'utilise.
-- ---------------------------------------------------------------------
create or replace function public.bataille_tirer()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a text[]; b text[]; champs text[]; na int; nb int; n int; i int;
        m int; joues int; depart int;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;

  m := public.bataille_manche();
  select count(*) filter (where gagnant is not null) into joues
    from public.bataille_duels where manche = m;
  -- Rien de joué sur la manche en cours : on la refait. Sinon, suivante.
  if m = 0 or joues > 0 then m := m + 1; end if;

  select array_agg(player_id order by random()) into a
    from public.bataille_inscrits where team = 'a';
  select array_agg(player_id order by random()) into b
    from public.bataille_inscrits where team = 'b';

  na := coalesce(array_length(a, 1), 0);
  nb := coalesce(array_length(b, 1), 0);
  if na = 0 or nb = 0 then
    raise exception 'Il faut au moins un joueur disponible dans chaque camp';
  end if;

  -- Autant de duels que le camp le plus fourni compte de joueurs.
  n := greatest(na, nb);

  select array_agg(cle order by random()) into champs from public.bataille_champions;
  if coalesce(array_length(champs, 1), 0) < n then
    raise exception 'Pas assez de champions au tirage';
  end if;

  /* On n'efface que la manche qu'on refait — les précédentes restent,
     elles racontent la soirée. La base refuse un DELETE sans WHERE
     (sql_safe_updates), et elle a raison : c'est le garde-fou qui
     empêche de vider une table d'un doigt qui ripe. */
  delete from public.bataille_duels where manche = m;

  -- Les identifiants continuent de courir d'une manche à l'autre.
  select coalesce(max(id), 0) into depart from public.bataille_duels;

  /* Le modulo recycle le camp le plus mince. Les deux listes étant
     déjà mélangées, celui qui rejoue est tiré au sort comme le reste. */
  for i in 1..n loop
    insert into public.bataille_duels (id, manche, joueur_a, joueur_b, champion)
    values (depart + i, m, a[((i - 1) % na) + 1], b[((i - 1) % nb) + 1], champs[i]);
  end loop;

  return jsonb_build_object('duels', n, 'manche', m,
    'rejoue_a', n - na, 'rejoue_b', n - nb);
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
--  La majorité des duels de la DERNIÈRE MANCHE emporte tout l'enjeu.
--  Le vainqueur n'est pas un paramètre, il se lit dans les duels : un
--  soir de fin de challenge, c'est moins discutable.
--
--  Sur une égalité, on ne tranche pas et on ne ferme rien : la réponse
--  est de rejouer une manche, pas de tirer à pile ou face.
-- ---------------------------------------------------------------------
drop function if exists public.bataille_resoudre(text);

create or replace function public.bataille_resoudre()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  va int; vb int; m int; gagnant text; perdant text;
  e jsonb; x int; camp text; signe int; i int;
  joueurs text[]; j text; part int; reste int; k int; n int := 0;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;

  m := public.bataille_manche();
  select count(*) filter (where gagnant = 'a'), count(*) filter (where gagnant = 'b')
    into va, vb from public.bataille_duels where manche = m;

  if va + vb = 0 then raise exception 'Aucun duel n''a encore de vainqueur'; end if;

  /* Égalité : rien n'est décidé, rien n'est fermé. On tire une manche
     de plus, et autant qu'il en faudra. */
  if va = vb then
    return jsonb_build_object('egalite', true, 'manche', m,
                              'a', va, 'b', vb, 'deplace', 0);
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

    /* DISTINCT : à camps inégaux, un joueur figure dans deux duels.
       Sans lui, il compterait deux parts — et comme le matricule de sa
       ligne est unique, la seconde serait refusée et ces LP
       s'évaporeraient. Les LP récompensent le camp, pas le nombre de
       fois qu'on est monté sur le ring. */
    if camp = 'a' then
      select array_agg(distinct joueur_a) into joueurs
        from public.bataille_duels where manche = m;
    else
      select array_agg(distinct joueur_b) into joueurs
        from public.bataille_duels where manche = m;
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
                            'manche', m, 'a', va, 'b', vb, 'enjeu', x,
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

-- Combien de duels, et qui remonte sur le ring.
select count(*) as duels,
       count(*) - count(distinct joueur_a) as rejoue_cote_a,
       count(*) - count(distinct joueur_b) as rejoue_cote_b
  from public.bataille_duels;

select d.manche, d.id, pa.name as mediocre, pb.name as pitoyable,
       c.nom as champion, d.gagnant
  from public.bataille_duels d
  join public.players pa on pa.id = d.joueur_a
  join public.players pb on pb.id = d.joueur_b
  left join public.bataille_champions c on c.cle = d.champion
 order by d.manche, d.id;

select count(*) as champions_au_tirage from public.bataille_champions;
select public.bataille_enjeu() as enjeu_du_moment;
