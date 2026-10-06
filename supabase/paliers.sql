-- =====================================================================
--  paliers.sql — un coffre en boutique
--
--  Les paliers du jour (3, 5 et 7 parties) sont posés par la fonction
--  « riot » au moment où une partie est enregistrée : c'est elle qui
--  compte les parties du jour, et elle seule. Rien à faire ici pour
--  eux — leur garde-fou est ailleurs, dans les deux index uniques :
--
--    player_boxes (player_id, source_match)
--    gold_ledger  (player_id, match_id)
--
--  Les deux reçoivent la même clé « palier-AAAA-MM-JJ-N ». Un relevé
--  qui repasse sur la journée ne peut donc pas payer deux fois, et on
--  n'a aucun compteur à tenir à jour.
--
--  Ce script n'ajoute que l'achat d'un coffre.
--
--  À lancer après coffres.sql et boutique-v2.sql. Idempotent.
-- =====================================================================

create or replace function public.shop_buy_box()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; prix int := 500;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;
  if moi.gold < prix then raise exception 'Il te manque % or', prix - moi.gold; end if;

  update public.players set gold = gold - prix where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -prix, 'achat : un coffre');

  -- Pas de source_match de partie : ce coffre ne vient d'aucune
  -- victoire. Un identifiant propre suffit à le distinguer.
  insert into public.player_boxes (player_id, source_match)
  values (moi.id, 'achat-' || gen_random_uuid());

  return jsonb_build_object(
    'prix', prix,
    'gold', moi.gold - prix,
    'restants', (select count(*) from public.player_boxes
                  where player_id = moi.id and opened_at is null));
end $$;

revoke all     on function public.shop_buy_box() from public, anon;
grant  execute on function public.shop_buy_box() to authenticated, service_role;

notify pgrst, 'reload schema';

select p.name, p.gold,
       count(*) filter (where b.opened_at is null) as coffres_en_attente
  from public.players p
  left join public.player_boxes b on b.player_id = p.id
 where p.alias_of is null
 group by p.name, p.gold
 order by p.gold desc;
