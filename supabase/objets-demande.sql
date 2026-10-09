-- =====================================================================
--  objets-demande.sql — le prix d'un objet suit aussi sa demande
--
--  Jusqu'ici un prix ne dépendait que de l'indice de la bourse. Il
--  dépend désormais de DEUX choses qui se multiplient :
--
--    prix = prix_base × coefficient de bourse × coefficient de demande
--
--  LA BOURSE, inchangée : l'indice monte, tout coûte plus cher ; il
--  s'effondre, les rayons passent en solde. Plus un objet est rare,
--  plus il est cyclique.
--
--  LA DEMANDE, nouvelle : un objet que tout le monde achète monte, un
--  objet que personne ne prend redescend. On compte les achats des
--  SEPT DERNIERS JOURS, et on compare chaque objet à la moyenne du
--  catalogue.
--
--  POURQUOI CETTE FORMULE
--      coef = ((achats + 2) / (moyenne + 2)) ^ 0,4,  borné à [0,80 ; 1,40]
--
--  Le +2 est un lissage : sans lui, passer de zéro à un achat ferait
--  doubler le prix, alors qu'un seul achat ne prouve rien. L'exposant
--  0,4 écrase les écarts — il faut beaucoup d'achats pour peser, pas
--  deux. Et les bornes empêchent qu'un objet devienne inachetable ou
--  bradé parce que trois personnes ont eu la même idée.
--
--  Mesuré sur les neuf achats du challenge au 9 octobre :
--    Égide du Contre (2 achats) 1 800 → 2 160     +20 %
--    Marque du Chasseur (2)       350 →   420     +20 %
--    Pierre de Garde (1)          350 →   375      +7 %
--    jamais achetés               800 →   730      −9 %
--
--  Seuls les OBJETS suivent la demande. Le coffre n'est pas concerné :
--  c'est la denrée de base, et il n'a pas de substitut.
--
--  À lancer après bourse.sql. Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
--  Les réglages, en un seul endroit
-- ---------------------------------------------------------------------
create or replace function public.demande_fenetre()  returns interval language sql immutable as $$ select interval '7 days' $$;
create or replace function public.demande_lissage()  returns numeric  language sql immutable as $$ select 2.0 $$;
create or replace function public.demande_exposant() returns numeric  language sql immutable as $$ select 0.4 $$;
create or replace function public.demande_min()      returns numeric  language sql immutable as $$ select 0.80 $$;
create or replace function public.demande_max()      returns numeric  language sql immutable as $$ select 1.40 $$;

grant execute on function public.demande_fenetre()  to anon, authenticated;
grant execute on function public.demande_lissage()  to anon, authenticated;
grant execute on function public.demande_exposant() to anon, authenticated;
grant execute on function public.demande_min()      to anon, authenticated;
grant execute on function public.demande_max()      to anon, authenticated;


-- ---------------------------------------------------------------------
--  Combien de fois un objet a été ACHETÉ récemment
--
--  On ne compte que les achats, jamais les objets tombés d'un coffre :
--  le butin ne dit rien de ce que les joueurs veulent, il dit ce que le
--  hasard leur a donné. Un achat porte le matricule « shop-… », un
--  butin « box-… ».
-- ---------------------------------------------------------------------
create or replace function public.demande_achats(p_item text)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.player_items
   where item_key = p_item
     and source_match like 'shop-%'
     and obtained_at > now() - public.demande_fenetre();
$$;
grant execute on function public.demande_achats(text) to anon, authenticated;


-- ---------------------------------------------------------------------
--  Le coefficient de demande d'un objet
-- ---------------------------------------------------------------------
create or replace function public.prix_demande(p_item text)
returns numeric language sql stable security definer set search_path = public as $$
  with n as (
    select i.key, public.demande_achats(i.key)::numeric as achats
      from public.items i where i.active
  )
  select greatest(public.demande_min(), least(public.demande_max(),
    power(
      (coalesce((select achats from n where n.key = p_item), 0) + public.demande_lissage())
      / (coalesce((select avg(achats) from n), 0) + public.demande_lissage()),
      public.demande_exposant())));
$$;
grant execute on function public.prix_demande(text) to anon, authenticated;


-- ---------------------------------------------------------------------
--  Le prix affiché et facturé : les deux coefficients se multiplient
-- ---------------------------------------------------------------------
create or replace function public.prix_objet(p_item text)
returns int language sql stable set search_path = public as $$
  select greatest(5, round(
           public.prix_indexe(i.price, i.rarity) * public.prix_demande(i.key) / 5) * 5)::int
    from public.items i where i.key = p_item;
$$;
grant execute on function public.prix_objet(text) to anon, authenticated;


-- ---------------------------------------------------------------------
--  L'achat facture le prix complet
--
--  Comme pour la bourse, c'est le prix calculé ICI qui est prélevé,
--  jamais celui qui était affiché : entre le moment où la page a été
--  dessinée et le clic, un autre joueur a pu acheter le même objet et
--  en faire monter le prix. La réponse dit ce qui a réellement été pris.
-- ---------------------------------------------------------------------
create or replace function public.shop_buy_item(p_item text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; it public.items; prix int;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;

  select * into it from public.items where key = p_item and active;
  if not found then raise exception 'Objet inconnu ou retiré du catalogue'; end if;

  -- On n'achète pas une surprise : il faut l'avoir déjà décroché une fois.
  if not exists (select 1 from public.player_items
                  where player_id = moi.id and item_key = p_item) then
    raise exception 'Tu ne peux acheter qu''un objet que tu as déjà obtenu en jeu';
  end if;

  prix := public.prix_objet(p_item);
  if moi.gold < prix then raise exception 'Il te manque % or', prix - moi.gold; end if;

  update public.players set gold = gold - prix where id = moi.id;
  insert into public.gold_ledger (player_id, delta, raison)
  values (moi.id, -prix, 'achat : ' || it.name);

  insert into public.player_items (player_id, item_key, source_match)
  values (moi.id, p_item, 'shop-' || gen_random_uuid());

  return jsonb_build_object('item', it.key, 'nom', it.name, 'prix', prix,
                            'base', it.price, 'or', moi.gold - prix,
                            'demande', round(public.prix_demande(p_item), 3));
end $$;

revoke all     on function public.shop_buy_item(text) from public, anon;
grant  execute on function public.shop_buy_item(text) to authenticated, service_role;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
--  Le catalogue au prix du jour, et d'où vient l'écart
-- ---------------------------------------------------------------------
select i.name,
       i.rarity,
       i.price                                        as base,
       public.demande_achats(i.key)                   as achats_7j,
       round(public.prix_indexe(i.price, i.rarity)
             / i.price::numeric, 3)                   as coef_bourse,
       round(public.prix_demande(i.key), 3)           as coef_demande,
       public.prix_objet(i.key)                       as prix_du_jour,
       round((public.prix_objet(i.key) / i.price::numeric - 1) * 100, 1) as ecart_pct
  from public.items i
 where i.active
 order by public.prix_objet(i.key) - i.price desc;
