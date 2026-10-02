-- =====================================================================
--  bac-a-sable.sql — simuler des parties et distribuer des objets
--
--  Le navigateur ne peut plus écrire une partie depuis riot-api.sql :
--  c'est voulu, personne ne doit pouvoir s'inventer des LP. Ce script
--  rouvre une porte étroite, réservée à l'administrateur, pour essayer
--  les objets sans attendre une vraie partie classée.
--
--  Tout ce qui sort d'ici est marqué « sim-… » dans match_id et
--  source_match : c'est ce qui permet de tout effacer d'un geste sans
--  toucher à une seule vraie partie.
--
--  Idempotent : le relancer ne casse rien.
-- =====================================================================

-- Les mêmes poids que le tirage de la fonction « riot » (POIDS_RARETE)
-- et que l'affichage du site. Trois endroits, une seule vérité à tenir.
create or replace function public.item_weight(p_rarity text)
returns int language sql immutable as $$
  select case p_rarity when 'commun' then 60 when 'rare' then 30
                       when 'legendaire' then 10 else 1 end;
$$;

-- Tirage pondéré par la rareté, parmi les objets actifs.
-- La clé -ln(U)/poids tirée par ligne, puis le minimum : chaque objet sort
-- avec la probabilité poids / total, sans avoir à cumuler quoi que ce soit.
-- random() vit dans [0,1) et ln(0) lève une erreur, d'où le 1 - random().
create or replace function public.draw_item()
returns text language sql volatile set search_path = public as $$
  select i.key from public.items i
   where i.active
   order by -ln(1 - random()) / public.item_weight(i.rarity)
   limit 1;
$$;


-- ---------------------------------------------------------------------
--  Donner un objet. p_item null => tirage au sort, comme un vrai butin.
-- ---------------------------------------------------------------------
create or replace function public.admin_grant_item(p_player text, p_item text default null)
returns text language plpgsql security definer set search_path = public as $$
declare cle text;
begin
  -- auth.uid() est null dans l'éditeur SQL : on l'y laisse passer, la
  -- fonction n'étant exposée qu'au rôle « authenticated ».
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Réservé à un administrateur';
  end if;

  cle := coalesce(p_item, public.draw_item());
  if cle is null then raise exception 'Aucun objet actif dans le catalogue'; end if;
  if not exists (select 1 from public.items where key = cle) then
    raise exception 'Objet inconnu : %', cle;
  end if;
  if not exists (select 1 from public.players where id = p_player) then
    raise exception 'Joueur inconnu';
  end if;

  insert into public.player_items (player_id, item_key, source_match)
  values (p_player, cle, 'sim-' || gen_random_uuid());
  return cle;
end $$;


-- ---------------------------------------------------------------------
--  Simuler une partie. Une victoire en duo avec un coéquipier fait
--  tomber un objet, exactement comme le relevé réel.
-- ---------------------------------------------------------------------
create or replace function public.admin_sim_game(
  p_player text, p_lp int, p_win boolean, p_duo text default 'solo')
returns jsonb language plpgsql security definer set search_path = public as $$
declare butin text; mid text;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Réservé à un administrateur';
  end if;
  if p_duo not in ('solo','team','enemy') then
    raise exception 'Duo invalide : %', p_duo;
  end if;
  if not exists (select 1 from public.players where id = p_player) then
    raise exception 'Joueur inconnu';
  end if;

  mid := 'sim-' || gen_random_uuid();
  insert into public.games (player_id, lp, win, duo, kind, match_id, played_on, created_by)
  values (p_player, p_lp, p_win, p_duo, 'game', mid, current_date,
          coalesce(auth.uid(), (select claimed_by from public.players where id = p_player)));

  if p_duo = 'team' and p_win then
    butin := public.draw_item();
    if butin is not null then
      insert into public.player_items (player_id, item_key, source_match)
      values (p_player, butin, mid);
    end if;
  end if;

  return jsonb_build_object('match_id', mid, 'item', butin);
end $$;


-- ---------------------------------------------------------------------
--  Tout effacer. Ne touche qu'aux lignes marquées « sim- ».
-- ---------------------------------------------------------------------
create or replace function public.admin_clear_sim()
returns jsonb language plpgsql security definer set search_path = public as $$
declare ng int; ni int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Réservé à un administrateur';
  end if;

  delete from public.player_items where source_match like 'sim-%';
  get diagnostics ni = row_count;
  delete from public.games where match_id like 'sim-%';
  get diagnostics ng = row_count;
  return jsonb_build_object('parties', ng, 'objets', ni);
end $$;


-- ---------------------------------------------------------------------
--  Droits : jamais « anon », sinon un visiteur s'inventerait des LP.
-- ---------------------------------------------------------------------
revoke all on function public.admin_grant_item(text, text)            from public, anon;
revoke all on function public.admin_sim_game(text, int, boolean, text) from public, anon;
revoke all on function public.admin_clear_sim()                        from public, anon;
revoke all on function public.draw_item()                              from public, anon, authenticated;

grant execute on function public.admin_grant_item(text, text)             to authenticated, service_role;
grant execute on function public.admin_sim_game(text, int, boolean, text) to authenticated, service_role;
grant execute on function public.admin_clear_sim()                        to authenticated, service_role;
grant execute on function public.draw_item()                              to service_role;

-- La suppression des parties simulées passe par admin_clear_sim, mais la
-- policy de suppression de riot-api.sql couvre déjà l'admin ligne à ligne.
select 'bac à sable prêt' as etat, count(*) filter (where active) as objets_actifs
  from public.items;
