-- =====================================================================
--  rattrapage-or.sql — l'or des parties jouées avant l'économie
--
--  Les 156 parties relevées avant le déploiement de l'économie n'ont ni
--  KDA, ni vision, ni poste : leur or ne peut pas être calculé. Ces
--  montants sont donc ESTIMÉS, à partir du seul élément dont on
--  dispose pour elles — le bilan victoires / défaites.
--
--      150 or par victoire, 50 par défaite.
--
--  C'est la borne BASSE de l'estimation (la haute était 185 / 75). Un
--  correctif trop généreux se rattrape beaucoup plus mal qu'un
--  correctif trop prudent : la boutique a été tarifée pour un gain
--  d'environ 12 000 or sur les 21 jours, et ce rattrapage en injecte
--  déjà 16 000 d'un coup.
--
--  Les parties qui ont DÉJÀ rapporté de l'or (celles d'après le
--  déploiement) sont exclues du compte : personne n'est payé deux fois.
--
--  CE SCRIPT NE PEUT PAS ÊTRE JOUÉ DEUX FOIS. Chaque crédit porte
--  l'étiquette « rattrapage-2026-10-04 », et l'index unique du journal
--  (player_id, match_id) refuse le doublon. Relancer ne fera rien.
--
--  Si tu veux être plus généreux, remplace 150 et 50 par tes valeurs
--  AVANT de lancer — et change l'étiquette, sinon le second passage
--  sera ignoré.
-- =====================================================================

select public.credit_gold('leuji-oioio',         2650, 'rattrapage des parties du 3 au 4 octobre', 'rattrapage-2026-10-04');
select public.credit_gold('snoozenlaw31-6262',   2000, 'rattrapage des parties du 3 au 4 octobre', 'rattrapage-2026-10-04');
select public.credit_gold('namelessdivnity-euw', 1900, 'rattrapage des parties du 3 au 4 octobre', 'rattrapage-2026-10-04');
select public.credit_gold('runailen-1051',       1850, 'rattrapage des parties du 3 au 4 octobre', 'rattrapage-2026-10-04');
select public.credit_gold('metaxou-meta',        1800, 'rattrapage des parties du 3 au 4 octobre', 'rattrapage-2026-10-04');
select public.credit_gold('monvraipseudo2-1876', 1500, 'rattrapage des parties du 3 au 4 octobre', 'rattrapage-2026-10-04');
select public.credit_gold('tankiste-euw',        1300, 'rattrapage des parties du 3 au 4 octobre', 'rattrapage-2026-10-04');
select public.credit_gold('flinkiis-euw',        1250, 'rattrapage des parties du 3 au 4 octobre', 'rattrapage-2026-10-04');
select public.credit_gold('aria-math-c4i8',       950, 'rattrapage des parties du 3 au 4 octobre', 'rattrapage-2026-10-04');
select public.credit_gold('le-big-mat-4583',      650, 'rattrapage des parties du 3 au 4 octobre', 'rattrapage-2026-10-04');
select public.credit_gold('ragemachala-noob',     150, 'rattrapage des parties du 3 au 4 octobre', 'rattrapage-2026-10-04');


-- Ce que ça donne. Les soldes doivent correspondre aux montants
-- ci-dessus, plus l'or déjà gagné depuis le déploiement.
select p.name, p.gold,
       (select sum(delta) from public.gold_ledger g
         where g.player_id = p.id and g.match_id = 'rattrapage-2026-10-04') as rattrape
  from public.players p
 order by p.gold desc;
