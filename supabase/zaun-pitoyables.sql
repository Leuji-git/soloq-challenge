-- =====================================================================
--  zaun-pitoyables.sql — Zaun Chimie rejoint Les Pitoyables
--
--  La cote manquait de symétrie : Les Médiocres avaient une
--  spéculative (Piltover Tech), Les Pitoyables n'en avaient aucune.
--  Zaun Chimie était spéculative et indépendante ; elle passe sous
--  pavillon pitoyable, son niveau de risque ne change pas.
--
--      Les Médiocres    PLT spéculative · DEM prudente · SHU équilibrée
--      Les Pitoyables   ZAU spéculative · NOX, FRE, IXT équilibrées
--      Indépendantes    ION, BIL, TRG
--
--  Son cours suivra désormais les LP des Pitoyables, EN PLUS du hasard
--  du marché qui continue de s'appliquer comme avant.
--
--  Idempotent.
-- =====================================================================

update public.bourse_societes
   set lien = 'b', risque = 'speculative'
 where code = 'ZAU';

insert into public.bourse_depeches (genre, majeur, code, titre, texte)
values ('info', false, 'ZAU', 'Zaun Chimie change de pavillon',
        'La société est désormais adossée aux Pitoyables. Son cours suivra leurs résultats.');

notify pgrst, 'reload schema';

select code, nom, risque, coalesce(lien, '—') as equipe, prix_base,
       round(public.bourse_cours_actuel(code), 1) as cours
  from public.bourse_societes
 where actif
 order by lien nulls last, risque, sort;
