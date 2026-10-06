-- =====================================================================
--  egide.sql — l'Égide renvoie les malus à leur auteur
--
--  Avant, elle les annulait : le malus ne coûtait plus rien à sa cible,
--  mais son auteur s'en tirait sans rien perdre non plus. Désormais
--  elle les lui retourne.
--
--  OÙ ATTERRIT LE MALUS RENVOYÉ
--  Sur une ligne à lp = 0 et lp_items négatif, au nom de l'auteur :
--  son classement individuel ne bouge pas — aucun objet ne le touche —
--  mais le score de son ÉQUIPE paye, exactement comme il aurait fait
--  payer celui de sa cible. C'est le même mécanisme que le Péage,
--  dans l'autre sens.
--
--  CE QUI N'EST PAS RENVOYÉ
--  Seuls les effets qui COÛTENT. Un Pile ou Face tombé du bon côté
--  rapporte à sa cible : il n'y a rien à annuler, et le renvoyer
--  reviendrait à récompenser son auteur.
--
--  À lancer après peage.sql. Idempotent.
-- =====================================================================

alter table public.games drop constraint if exists games_kind_valid;
do $$ begin
  alter table public.games add constraint games_kind_valid
    check (kind in ('game','adjust','shop','peage','renvoi'));
exception when duplicate_object then null; end $$;

update public.items set
  effect = 'Si tu gagnes cette partie, tous les malus posés sur toi sont annulés et renvoyés sur leur auteur. Si tu perds, elle ne sert à rien.'
 where key = 'egide_contre';

notify pgrst, 'reload schema';

select key, name, rarity, price, effect from public.items where key = 'egide_contre';
