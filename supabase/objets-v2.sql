-- =====================================================================
--  objets-v2.sql — révision du catalogue
--
--  CE QUI CHANGE
--    · Bottes de Célérité   +20 → +30 LP
--    · Baron Nashor         +25 → +30 LP, et autant au duo allié
--    · Brouillard de Guerre seuil de vision 15 → 30
--    · Bourse Coupée        150 → 500 or volés
--    · Pile ou Face         défaite : −30 LP → −40 LP et −1 000 or
--    · Égide du Contre      rare → légendaire
--    · Amnésie              légendaire → rare
--    · NOUVEAU : Pioche du Nain, commun
--
--  ET UNE RÈGLE DE TIRAGE
--  Un objet qu'on n'a jamais eu sort trois fois plus souvent. Dès qu'on
--  l'obtient, il retombe au poids de sa rareté. Sans ça, les derniers
--  objets d'un catalogue de seize se font attendre très longtemps :
--  à 1,7 %, un légendaire précis demande une quarantaine de coffres.
--
--  Le prix suit la rareté : 350 commun, 800 rare, 1 800 légendaire.
--  L'Égide passe donc de 800 à 1 800, l'Amnésie de 1 800 à 800.
--
--  À lancer après egide.sql. Idempotent.
-- =====================================================================

-- La part du coéquipier est une ligne de partie d'un genre nouveau.
alter table public.games drop constraint if exists games_kind_valid;
do $$ begin
  alter table public.games add constraint games_kind_valid
    check (kind in ('game','adjust','shop','peage','renvoi','partage'));
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
--  1. Le nouvel objet
-- ---------------------------------------------------------------------
insert into public.items (key, name, icon, rarity, target, teaser, effect, sort, price, charges, active)
values ('pioche_nain', 'Pioche du Nain', '⛏️', 'commun', 'soi',
        'Qui creuse assez profond finit toujours par trouver.',
        'Si tu amasses 10 000 or ou plus dans cette partie, gagnée ou perdue : +500 or.',
        8, 350, 1, true)
on conflict (key) do update set
  name = excluded.name, icon = excluded.icon, rarity = excluded.rarity,
  target = excluded.target, teaser = excluded.teaser, effect = excluded.effect,
  sort = excluded.sort, price = excluded.price, active = excluded.active;


-- ---------------------------------------------------------------------
--  2. Les raretés qui bougent
--     Le poids de tirage suit tout seul : il est calculé depuis la
--     rareté par item_weight(), rien d'autre à toucher.
-- ---------------------------------------------------------------------
update public.items set rarity = 'legendaire' where key = 'egide_contre';
update public.items set rarity = 'rare'       where key = 'amnesie';

/* Le prix suit la rarete, pour tout le catalogue d'un coup. Ecrire les
   deux objets concernes aurait suffi aujourd'hui, mais une grille qui
   se reapplique en entier ne peut pas se desynchroniser : changer une
   rarete suffira toujours a remettre le prix d'aplomb. */
update public.items set price = case rarity
    when 'commun'     then 350
    when 'rare'       then 800
    when 'legendaire' then 1800
    else price end;


-- ---------------------------------------------------------------------
--  3. Les fiches
--     Elles doivent dire exactement ce que fait EFFETS dans la fonction
--     « riot » : c'est le code qui calcule, le texte ne fait que le
--     raconter.
-- ---------------------------------------------------------------------
update public.items set effect = v.effect from (values
  ('bottes_celerite', 'Si tu gagnes cette partie en moins de 25 minutes : +30 LP.'),
  ('baron_nashor',    'Si tu gagnes cette partie : +30 LP. En duo allié, ton coéquipier touche autant.'),
  ('brouillard',      'Si le score de vision de ta cible est sous 30 : −15 LP.'),
  ('bourse_coupee',   'Si ta cible perd sa prochaine partie, tu lui prends 500 or.'),
  ('pile_ou_face',    'Sur la prochaine partie de ta cible : +30 LP si elle gagne ; si elle perd, −40 LP et −1 000 or. Rien ne te revient dans un cas comme dans l''autre.')
) as v(key, effect) where public.items.key = v.key;


-- ---------------------------------------------------------------------
--  4. Le tirage favorise ce qu'on n'a pas encore
--
--  draw_item prend maintenant le joueur. Un objet absent de sa réserve
--  — jamais obtenu, même consommé depuis — voit son poids multiplié.
--
--  L'ancienne version sans argument est supprimée : garder les deux
--  rendrait l'appel draw_item() ambigu pour Postgres.
-- ---------------------------------------------------------------------
drop function if exists public.draw_item();
drop function if exists public.draw_item(text);

create or replace function public.draw_item(p_player text default null)
returns text language sql volatile set search_path = public as $$
  select i.key from public.items i
   where i.active
   -- Course exponentielle pondérée : chaque objet tire un temps au
   -- hasard, le plus petit gagne, et un poids triple divise le temps
   -- par trois. C'est exactement « trois fois plus de chances ».
   order by -ln(1 - random()) /
     (public.item_weight(i.rarity) * case
        when p_player is not null and not exists (
               select 1 from public.player_items pi
                where pi.player_id = p_player and pi.item_key = i.key)
        then 3 else 1 end)
   limit 1;
$$;

revoke all     on function public.draw_item(text) from public, anon, authenticated;
grant  execute on function public.draw_item(text) to service_role;


-- ---------------------------------------------------------------------
--  5. L'ouverture passe le joueur au tirage
-- ---------------------------------------------------------------------
create or replace function public.open_box()
returns jsonb language plpgsql security definer set search_path = public as $$
declare moi public.players; boite public.player_boxes; cle text; it public.items;
begin
  select * into moi from public.players where claimed_by = auth.uid();
  if not found then raise exception 'Connecte-toi avec ton profil joueur'; end if;

  -- for update skip locked : deux clics simultanés ouvrent deux coffres
  -- différents, jamais le même deux fois.
  select * into boite from public.player_boxes
   where player_id = moi.id and opened_at is null
   order by obtained_at limit 1
   for update skip locked;
  if not found then raise exception 'Tu n''as aucun coffre à ouvrir'; end if;

  -- Avec le joueur : ce qu'il n'a jamais eu sort trois fois plus souvent.
  cle := public.draw_item(moi.id);
  if cle is null then raise exception 'Aucun objet actif dans le catalogue'; end if;

  update public.player_boxes set opened_at = now(), item_key = cle where id = boite.id;

  insert into public.player_items (player_id, item_key, source_match)
  values (moi.id, cle, 'box-' || boite.id);

  select * into it from public.items where key = cle;
  return jsonb_build_object(
    'key', it.key, 'name', it.name, 'icon', it.icon,
    'rarity', it.rarity, 'target', it.target, 'effect', it.effect,
    'restants', (select count(*) from public.player_boxes
                  where player_id = moi.id and opened_at is null));
end $$;

revoke all     on function public.open_box() from public, anon;
grant  execute on function public.open_box() to authenticated, service_role;

notify pgrst, 'reload schema';


-- Le catalogue tel qu'il sera, et la chance de base de chaque objet.
select i.key, i.name, i.rarity, i.target, i.price,
       round(100.0 * public.item_weight(i.rarity)
             / (select sum(public.item_weight(x.rarity)) from public.items x where x.active), 1)
         as chance_de_base_pct,
       i.effect
  from public.items i
 where i.active
 order by i.target, i.sort;
