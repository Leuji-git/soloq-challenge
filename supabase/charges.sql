-- =====================================================================
--  charges.sql — un objet qui dure plusieurs parties
--
--  LE PROBLÈME
--  La Larme de la Déesse annonce « +3 LP sur chacune de tes 5
--  prochaines parties ». Le moteur, lui, ne savait faire qu'une chose :
--  un objet armé agit sur UNE partie et se consomme. Il appliquait donc
--  +5 LP une fois, et le texte mentait.
--
--  LE CHOIX
--  On n'invente pas un deuxième mécanisme à côté. Une ligne reste « une
--  utilisation » : c'est elle qui porte le détail de SA partie dans le
--  récap, et c'est ce qui permet d'expliquer chaque LP affiché. Un objet
--  à plusieurs charges se contente donc de se REPOSER tout seul : la
--  ligne consommée en réarme une neuve sur la même cible, avec une
--  charge de moins.
--
--  Conséquences voulues :
--   · le récap montre l'objet sur chacune des parties où il a agi ;
--   · la nouvelle ligne est verrouillée à la FIN de la partie qui vient
--     de se jouer, donc avant le début de la suivante — la règle « armé
--     avant le début » tient toujours ;
--   · elle naît hors de la fenêtre d'annulation de deux minutes : on ne
--     peut pas se défiler en cours de route ;
--   · elle occupe la place de bonus tant qu'elle dure. C'est le prix.
--
--  À lancer après objets-effets.sql. Idempotent.
-- =====================================================================

-- Combien de parties un objet dure. 1 = le comportement d'avant.
alter table public.items add column if not exists charges int not null default 1;

do $$ begin
  alter table public.items add constraint items_charges_valides
    check (charges between 1 and 20);
exception when duplicate_object then null; end $$;

-- Ce qu'il reste à cette ligne-ci. Posé au verrouillage.
alter table public.player_items add column if not exists restantes int;

-- La Larme dure cinq parties, et le dit.
update public.items
   set charges = 5,
       effect  = '+3 LP sur chacune de tes 5 prochaines parties. Elle occupe ta place de bonus tant qu''elle dure.'
 where key = 'larme_deesse';


-- ---------------------------------------------------------------------
--  lock_item : pose aussi le nombre de charges
--  (identique à objets-effets.sql, à ces deux lignes près)
-- ---------------------------------------------------------------------
create or replace function public.lock_item(p_item uuid, p_target text)
returns public.player_items language plpgsql security definer set search_path = public as $$
declare it public.player_items; cible public.players; moi public.players;
        genre text; nb int; n int;
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

  select target, charges into genre, nb from public.items where key = it.item_key;
  if genre = 'soi' and cible.id <> moi.id then
    raise exception 'Ce bonus ne peut se poser que sur toi';
  end if;
  if genre = 'adversaire' and cible.team = moi.team then
    raise exception 'Ce malus ne se pose que sur un adversaire';
  end if;

  -- Plafonds : au plus 1 bonus et 3 malus armés en même temps.
  select count(*) into n
    from public.player_items pi
    join public.items i on i.key = pi.item_key
   where pi.player_id = moi.id
     and pi.used_at is null and pi.locked_at is not null
     and i.target = genre;

  if genre = 'soi' and n >= 1 then
    raise exception 'Tu as déjà un bonus armé. Attends qu''il agisse.';
  end if;
  if genre = 'adversaire' and n >= 3 then
    raise exception 'Tu as déjà trois malus armés. Attends qu''ils agissent.';
  end if;

  update public.player_items
     set locked_at = now(), target_id = p_target,
         restantes = greatest(1, coalesce(nb, 1))
   where id = p_item
  returning * into it;

  insert into public.item_locks_log (item_row, player_id, item_key, target_id, action)
  values (it.id, it.player_id, it.item_key, it.target_id, 'lock');

  return it;
end $$;


-- ---------------------------------------------------------------------
--  unlock_item : rendre l'objet, c'est aussi oublier ses charges
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
  if it.locked_at is null then raise exception 'Cet objet n''est pas verrouillé'; end if;

  -- Une recharge ne se rend pas. L'objet a été armé pour cinq parties,
  -- et le prix de ces cinq parties est d'occuper la place de bonus
  -- jusqu'au bout. Pouvoir décrocher après la première le rendrait
  -- gratuit, donc strictement meilleur que tous les autres.
  if it.source_match like 'charge-%' and not public.is_admin() then
    raise exception 'Cet objet est en cours : il agira sur les parties qu''il lui reste.';
  end if;

  if it.locked_at < now() - interval '2 minutes' and not public.is_admin() then
    raise exception 'Trop tard pour annuler : un objet ne se reprend que dans les 2 minutes qui suivent son verrouillage.';
  end if;

  update public.player_items
     set locked_at = null, target_id = null, restantes = null
   where id = p_item
  returning * into it;

  insert into public.item_locks_log (item_row, player_id, item_key, target_id, action)
  values (p_item, it.player_id, it.item_key, null, 'unlock');

  return it;
end $$;

revoke all     on function public.lock_item(uuid, text) from public, anon;
revoke all     on function public.unlock_item(uuid)     from public, anon;
grant  execute on function public.lock_item(uuid, text) to authenticated, service_role;
grant  execute on function public.unlock_item(uuid)     to authenticated, service_role;


-- ---------------------------------------------------------------------
--  Le ménage du bac à sable doit emporter les recharges nées d'une
--  simulation. Elles portent le matricule de la partie simulée, donc
--  « charge-sim-… » : on les reconnaît sans ambiguïté.
-- ---------------------------------------------------------------------
create or replace function public.admin_clear_sim()
returns jsonb language plpgsql security definer set search_path = public as $$
declare ng int; ni int; nr int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Réservé à un administrateur';
  end if;

  update public.player_items
     set used_at = null, applied_match = null, lp_effect = null, note = null,
         locked_at = null, target_id = null, restantes = null
   where applied_match like 'sim-%';
  get diagnostics nr = row_count;

  delete from public.player_items
   where source_match like 'sim-%' or source_match like 'charge-sim-%';
  get diagnostics ni = row_count;
  delete from public.games where match_id like 'sim-%';
  get diagnostics ng = row_count;
  return jsonb_build_object('parties', ng, 'objets', ni, 'rendus', nr);
end $$;

revoke all     on function public.admin_clear_sim() from public, anon;
grant  execute on function public.admin_clear_sim() to authenticated, service_role;

notify pgrst, 'reload schema';

select key, name, charges, effect from public.items order by charges desc, sort;
