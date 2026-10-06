-- =====================================================================
--  ange-gardien.sql — l'Ange Gardien rattrape la défaite d'avant
--
--  L'objet existait déjà, mais sa fiche et son moteur ne disaient pas
--  la même chose : le catalogue promettait « la prochaine fois que tu
--  perds deux parties d'affilée, la seconde est annulée », et le code
--  rendait la moitié des LP d'une défaite. Aucune des deux versions
--  n'était celle qu'on voulait.
--
--  La règle retenue, une bonne fois :
--    tu l'armes avant une partie ; si tu la GAGNES, tu récupères les
--    LP nets que ta partie PRÉCÉDENTE t'a coûtés.
--
--  Le plafond de 50 LP n'est pas une coquetterie : une ligne marquée
--  « estimée » peut porter plusieurs parties d'un coup quand le relevé
--  en a raté, et sans plafond l'objet rendrait d'un coup une soirée
--  entière.
--
--  À lancer après objets-effets.sql. Idempotent.
-- =====================================================================

update public.items set
  effect = 'Si tu gagnes cette partie, tu récupères les LP nets perdus sur ta partie précédente (50 au maximum).',
  teaser = 'Il veille en silence, et répare ce qui vient d''être brisé.'
 where key = 'ange_gardien';

notify pgrst, 'reload schema';

select key, name, rarity, price, effect from public.items where key = 'ange_gardien';
