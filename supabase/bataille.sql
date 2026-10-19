-- =====================================================================
--  bataille.sql — l'Ultime Bataille, et la fin de l'achat de LP
--
--  DEUX CHOSES, LE MÊME SOIR.
--
--  1. ON NE VEND PLUS DE LP. Les 25 LP à 6 000 or disparaissent de la
--     boutique. À trois jours de la fin, un joueur assis sur sa bourse
--     pouvait acheter l'écart ; désormais les LP se gagnent en jouant,
--     ou se prennent jeudi soir sur la faille. Le reste du Commerce ne
--     bouge pas.
--
--  2. L'ULTIME BATAILLE. Jeudi 22 octobre à 21 h, un 5 contre 5, et
--     1 000 LP pour le camp qui l'emporte.
--
--     Chacun s'inscrit en choisissant SON POSTE, et un seul joueur par
--     poste et par équipe : le premier inscrit tient le rôle, les
--     suivants passent remplaçants. Celui qui se désiste libère sa
--     place, et le premier remplaçant sur ce poste y monte aussitôt.
--
--     On ne choisit JAMAIS son camp. L'équipe n'est pas un paramètre
--     des fonctions ci-dessous : elle est lue sur la fiche du joueur,
--     côté serveur. Même en appelant l'API à la main, on ne peut pas
--     s'inscrire chez l'adversaire — il n'y a aucun chemin pour le
--     demander.
--
--  Idempotent. À lancer dans le SQL Editor.
-- =====================================================================


-- =====================================================================
--  1. LA BOUTIQUE NE VEND PLUS DE LP
--
--  On garde la fonction au lieu de la supprimer : une page encore
--  ouverte dans un onglet appellerait une fonction disparue et
--  afficherait « 404 », ce qui ressemble à une panne. Là, elle dit
--  pourquoi.
-- =====================================================================
create or replace function public.shop_buy_lp(p_lp int)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Les LP ne sont plus en vente. À partir de maintenant ils se gagnent en jouant — ou jeudi soir, à l''Ultime Bataille.';
end $$;

revoke all     on function public.shop_buy_lp(int) from public, anon;
grant  execute on function public.shop_buy_lp(int) to authenticated, service_role;


-- =====================================================================
--  2. L'ÉVÉNEMENT
-- =====================================================================
create table if not exists public.bataille (
  id     int primary key default 1,
  quand  timestamptz not null,
  lot    int  not null default 1000,
  ouvert boolean not null default true,
  constraint bataille_une_seule check (id = 1)
);

-- Jeudi 22 octobre 2026, 21 h, heure de Paris.
insert into public.bataille (id, quand, lot, ouvert)
values (1, timestamptz '2026-10-22 21:00:00 Europe/Paris', 1000, true)
on conflict (id) do nothing;

create table if not exists public.bataille_inscrits (
  player_id  text primary key references public.players(id) on delete cascade,
  -- Recopiée depuis la fiche du joueur, jamais fournie par le client.
  team       text not null check (team in ('a','b')),
  role       text not null check (role in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY')),
  titulaire  boolean not null default true,
  inscrit_le timestamptz not null default now()
);

/* Un seul titulaire par poste et par équipe. L'index partiel fait la
   règle : deux joueurs peuvent viser le même poste, un seul le tient,
   et la base refuserait l'inscription même si la fonction se trompait. */
create unique index if not exists bataille_poste_titulaire
  on public.bataille_inscrits (team, role) where titulaire;

alter table public.bataille          enable row level security;
alter table public.bataille_inscrits enable row level security;

/* Lecture ouverte : la composition des deux camps fait partie du jeu,
   et savoir quel poste est encore libre est le premier renseignement
   qu'on vient chercher.

   AUCUNE policy d'écriture, volontairement : tout passe par les deux
   fonctions plus bas, qui lisent l'équipe sur la fiche du joueur. */
drop policy if exists bataille_read          on public.bataille;
drop policy if exists bataille_inscrits_read on public.bataille_inscrits;
create policy bataille_read          on public.bataille          for select to anon, authenticated using (true);
create policy bataille_inscrits_read on public.bataille_inscrits for select to anon, authenticated using (true);

do $$ begin
  alter publication supabase_realtime add table public.bataille_inscrits;
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
--  Qui suis-je, pour cette bataille
--
--  Un second compte joue pour le joueur qu'il double : on remonte donc
--  à la fiche principale. Sans ça, Tankiste pourrait s'inscrire deux
--  fois, une fois par compte.
-- ---------------------------------------------------------------------
create or replace function public.bataille_moi()
returns public.players language plpgsql stable security definer set search_path = public as $$
declare moi public.players;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if moi.alias_of is not null then
    select * into moi from public.players where id = moi.alias_of;
    if not found then raise exception 'Compte secondaire orphelin : préviens l''administrateur'; end if;
  end if;
  return moi;
end $$;

-- Le créneau est-il encore ouvert aux inscriptions ?
create or replace function public.bataille_verifie()
returns public.bataille language plpgsql stable security definer set search_path = public as $$
declare b public.bataille;
begin
  select * into b from public.bataille where id = 1;
  if not found then raise exception 'Aucune bataille n''est programmée'; end if;
  if not b.ouvert then raise exception 'Les inscriptions sont closes'; end if;
  if now() >= b.quand then raise exception 'La bataille a déjà commencé'; end if;
  return b;
end $$;

/* Le poste laissé vide ne le reste pas : le remplaçant qui l'a demandé
   en premier y monte. Appelée après chaque départ. */
create or replace function public.bataille_promouvoir(p_team text, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare suivant text;
begin
  if exists (select 1 from public.bataille_inscrits
              where team = p_team and role = p_role and titulaire) then
    return;
  end if;
  select player_id into suivant from public.bataille_inscrits
   where team = p_team and role = p_role and not titulaire
   order by inscrit_le limit 1;
  if found then
    update public.bataille_inscrits set titulaire = true where player_id = suivant;
  end if;
end $$;


-- ---------------------------------------------------------------------
--  S'INSCRIRE, ou changer de poste
--
--  p_role est le SEUL paramètre. Pas de joueur, pas d'équipe : on ne
--  peut inscrire que soi, et que dans son camp.
-- ---------------------------------------------------------------------
create or replace function public.bataille_inscrire(p_role text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; b public.bataille;
        avant public.bataille_inscrits; libre boolean;
begin
  b   := public.bataille_verifie();
  moi := public.bataille_moi();

  if p_role is null or p_role not in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY') then
    raise exception 'Choisis un poste : top, jungle, mid, bot ou support';
  end if;

  -- Si je tenais déjà un poste, je le libère AVANT de prendre le
  -- nouveau — sinon changer de rôle buterait sur mon propre verrou.
  select * into avant from public.bataille_inscrits where player_id = moi.id;
  if found then
    if avant.role = p_role then
      return jsonb_build_object('role', p_role, 'titulaire', avant.titulaire,
                                'equipe', moi.team, 'change', false);
    end if;
    delete from public.bataille_inscrits where player_id = moi.id;
    if avant.titulaire then perform public.bataille_promouvoir(avant.team, avant.role); end if;
  end if;

  libre := not exists (select 1 from public.bataille_inscrits
                        where team = moi.team and role = p_role and titulaire);

  insert into public.bataille_inscrits (player_id, team, role, titulaire)
  values (moi.id, moi.team, p_role, libre);

  return jsonb_build_object('role', p_role, 'titulaire', libre,
                            'equipe', moi.team, 'change', true);
end $$;


-- ---------------------------------------------------------------------
--  SE DÉSISTER
-- ---------------------------------------------------------------------
create or replace function public.bataille_desister()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; avant public.bataille_inscrits;
begin
  perform public.bataille_verifie();
  moi := public.bataille_moi();

  select * into avant from public.bataille_inscrits where player_id = moi.id;
  if not found then raise exception 'Tu n''es pas inscrit'; end if;

  delete from public.bataille_inscrits where player_id = moi.id;
  if avant.titulaire then perform public.bataille_promouvoir(avant.team, avant.role); end if;

  return jsonb_build_object('desiste', true, 'role', avant.role);
end $$;

revoke all     on function public.bataille_inscrire(text) from public, anon;
revoke all     on function public.bataille_desister()     from public, anon;
revoke all     on function public.bataille_moi()          from public, anon;
revoke all     on function public.bataille_verifie()      from public, anon;
revoke all     on function public.bataille_promouvoir(text, text) from public, anon;
grant  execute on function public.bataille_inscrire(text) to authenticated, service_role;
grant  execute on function public.bataille_desister()     to authenticated, service_role;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
--  Vérification
-- ---------------------------------------------------------------------
select quand at time zone 'Europe/Paris' as le_soir_dit, lot, ouvert
  from public.bataille where id = 1;

select i.team, i.role, p.name, i.titulaire, i.inscrit_le
  from public.bataille_inscrits i
  join public.players p on p.id = i.player_id
 order by i.team, i.titulaire desc, i.role;

-- Doit répondre : les LP ne sont plus en vente.
do $$ begin
  perform public.shop_buy_lp(25);
  raise warning 'ANOMALIE : la vente de LP répond encore';
exception when others then
  raise notice 'Vente de LP bien fermée (%)', sqlerrm;
end $$;
