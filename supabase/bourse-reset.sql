-- =====================================================================
--  bourse-reset.sql — rembourser, effacer, repartir d'une cote saine
--
--  CE QUI S'EST PASSÉ
--  La forme d'une équipe décrit l'heure qui vient de s'écouler. Au
--  premier amorçage, deux cents créneaux ont été fabriqués d'un coup,
--  et cette même heure a été rejouée deux cents fois. Résultat : les
--  six sociétés liées à une équipe sont parties à ±98 % pendant que
--  les quatre indépendantes bougeaient normalement.
--
--    PLT −98 %   DEM −73 %   SHU −96 %      (Les Médiocres)
--    NOX +5067 % FRE +4426 % IXT +4808 %    (Les Pitoyables)
--
--  Trois ordres ont été passés à ces prix-là. Ils sont remboursés au
--  centime : ni gain ni perte, la bourse n'avait pas lieu d'être.
--
--  La cause est corrigée dans bourse.sql — À LANCER AVANT CELUI-CI,
--  sinon le réamorçage reproduirait le même dégât.
--
--  Idempotent : un second passage ne rembourse pas deux fois.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. Rembourser ce qui a été engagé
--     On repart du journal d'or, pas des positions : il porte aussi
--     les ventes, et il est la seule trace de ce qui a réellement été
--     prélevé, frais compris.
-- ---------------------------------------------------------------------
with engage as (
  select l.player_id, -sum(l.delta) as rendu
    from public.gold_ledger l
   where l.raison like 'bourse : %'
   group by l.player_id
  having -sum(l.delta) <> 0
),
neuf as (
  select e.* from engage e
   where not exists (
     select 1 from public.gold_ledger r
      where r.player_id = e.player_id
        and r.raison = 'remboursement : bourse remise à zéro')
),
trace as (
  insert into public.gold_ledger (player_id, delta, raison)
  select player_id, rendu, 'remboursement : bourse remise à zéro' from neuf
  returning player_id, delta
)
update public.players p
   set gold = greatest(0, p.gold + t.delta)
  from trace t
 where p.id = t.player_id;


-- ---------------------------------------------------------------------
--  2. Effacer la cote et ce qu'elle a raconté
-- ---------------------------------------------------------------------
delete from public.bourse_positions;
delete from public.bourse_cours;
delete from public.bourse_depeches;

update public.bourse_societes set derive = 0;

update public.bourse_etat
   set slot = public.bourse_slot() - 200,
       secousse_genre = null, secousse_cible = null,
       secousse_force = null, secousse_reste = 0, repos = 0
 where id = 1;


-- ---------------------------------------------------------------------
--  3. Réamorcer avec la fonction corrigée
--     Deux cents créneaux, mais cette fois sans forme d'équipe : sur un
--     rattrapage elle vaut zéro, et seules l'humeur du marché et le
--     bruit de fond jouent. C'est exactement ce qu'on veut d'un passé
--     qu'on ne connaît pas.
-- ---------------------------------------------------------------------
select public.bourse_tick(200) as amorcage;


-- ---------------------------------------------------------------------
--  Vérification : plus aucune société ne doit s'écarter fortement de
--  son prix d'introduction après un simple amorçage.
-- ---------------------------------------------------------------------
select s.code, s.nom, s.lien, s.risque, s.prix_base,
       round(public.bourse_cours_actuel(s.code), 1) as cours,
       round((public.bourse_cours_actuel(s.code) / s.prix_base - 1) * 100, 1) as ecart_pct
  from public.bourse_societes s
 where s.actif
 order by abs(public.bourse_cours_actuel(s.code) / s.prix_base - 1) desc;

select p.name, p.gold,
       (select count(*) from public.bourse_positions b where b.player_id = p.id) as positions
  from public.players p
 where p.alias_of is null
   and exists (select 1 from public.gold_ledger l
                where l.player_id = p.id and l.raison like 'bourse%')
 order by p.name;
