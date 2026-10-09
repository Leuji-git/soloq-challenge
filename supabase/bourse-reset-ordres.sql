-- =====================================================================
--  bourse-reset-ordres.sql — tout le monde repart du même point
--
--  POURQUOI
--  Les quinze ordres déjà passés l'ont été sous les anciennes règles :
--  1 % de frais, aucune durée de détention, aucun plafond quotidien.
--  Les garder donnerait un avantage à ceux qui ont joué avant le
--  resserrage.
--
--  Et surtout, le semis de deux cents bougies avait creusé des écarts
--  qui n'avaient rien à voir avec le jeu, AVANT que quiconque puisse
--  acheter :
--
--      PLT −57 %   ZAU −23 %   DEM −11 %   ION −10 %   SHU −4 %
--      TRG −2 %    IXT +37 %   NOX +52 %   FRE +65 %   BIL +95 %
--
--  Celui qui prenait BIL et celui qui prenait PLT ne jouaient pas au
--  même jeu. L'indice était monté à 1 142, ce qui gonflait au passage
--  tous les prix du Commerce.
--
--  CE QUE FAIT CE SCRIPT
--    1. il rend à chacun, au centime, l'or engagé en bourse ;
--    2. il efface les positions ;
--    3. il rend à tout le monde ses douze ordres du jour ;
--    4. il recrée une cote centrée sur les prix d'introduction.
--
--  L'or gagné en jouant n'est pas touché. Seule la bourse est remise à
--  plat.
--
--  À lancer après equilibrage.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. Rendre l'or engagé
--
--  On repart du journal d'or et non des positions : il porte aussi les
--  ventes déjà faites, et il est la seule trace de ce qui a réellement
--  été prélevé, frais compris. Rendre l'opposé de la somme nette remet
--  chacun exactement là où il serait s'il n'avait jamais rien acheté.
-- ---------------------------------------------------------------------
with engage as (
  select l.player_id, -sum(l.delta) as rendu
    from public.gold_ledger l
   where l.raison like 'bourse : %'
   group by l.player_id
  having -sum(l.delta) <> 0
),
trace as (
  insert into public.gold_ledger (player_id, delta, raison)
  select player_id, rendu, 'remboursement : ordres annulés, nouvelles règles' from engage
  returning player_id, delta
)
update public.players p
   set gold = greatest(0, p.gold + t.delta)
  from trace t
 where p.id = t.player_id;


-- ---------------------------------------------------------------------
--  2. Effacer les positions
-- ---------------------------------------------------------------------
delete from public.bourse_positions;


-- ---------------------------------------------------------------------
--  3. Rendre les ordres du jour
--
--  Le compteur quotidien lit le journal d'or. Plutôt que d'effacer ces
--  lignes — on perdrait la trace de ce qui s'est passé — on les
--  renomme : elles ne correspondent plus au motif compté, et elles
--  restent lisibles dans l'historique.
-- ---------------------------------------------------------------------
update public.gold_ledger
   set raison = replace(raison, 'bourse : ', 'bourse annulée : ')
 where raison like 'bourse : %';


-- ---------------------------------------------------------------------
--  4. Une cote centrée
--
--  Soixante bougies, avec un rappel vers le prix d'introduction à
--  chaque pas. L'historique garde du relief — sans quoi le graphique
--  serait une ligne plate et les chandeliers ne diraient rien — mais
--  aucune société ne peut s'éloigner de son point de départ.
--
--  Ce rappel ne vaut QUE pour ce semis. Le relevé normal, lui, garde sa
--  marche aléatoire : à partir de maintenant les écarts se creuseront,
--  mais ils viendront du marché et du jeu, pas du hasard d'un
--  historique fabriqué avant l'ouverture.
-- ---------------------------------------------------------------------
delete from public.bourse_cours;
delete from public.bourse_depeches;
update public.bourse_societes set derive = 0;

do $$
declare
  s record; i int;
  n int := 60;
  depart bigint;
  ouv numeric; clo numeric; amp numeric;
begin
  depart := public.bourse_slot() - n;
  for s in select * from public.bourse_societes where actif order by sort loop
    ouv := s.prix_base;
    for i in 1..n loop
      clo := greatest(4,
               ouv
               + (s.prix_base - ouv) * 0.25                       -- le rappel
               + s.prix_base * (random() - 0.5) * 0.02            -- le relief
                 * public.bourse_vol(s.risque));
      amp := abs(ouv - clo) + s.prix_base * random() * 0.006;

      insert into public.bourse_cours (code, slot, at, o, h, b, c)
      values (s.code, depart + i, to_timestamp((depart + i) * 300),
              round(ouv::numeric, 2),
              round((greatest(ouv, clo) + amp * random() * 0.6)::numeric, 2),
              round((greatest(2, least(ouv, clo) - amp * random() * 0.6))::numeric, 2),
              round(clo::numeric, 2))
      on conflict (code, slot) do nothing;

      ouv := clo;
    end loop;
  end loop;
end $$;

update public.bourse_etat
   set slot = public.bourse_slot(),
       secousse_genre = null, secousse_cible = null,
       secousse_force = null, secousse_reste = 0, repos = 0
 where id = 1;

insert into public.bourse_depeches (genre, majeur, titre, texte)
values ('info', true, 'Réouverture de la Place',
        'Les cours repartent de leur prix d''introduction et les ordres précédents ont été remboursés. '
        || 'Nouvelles règles : 2 % de frais, trente minutes de détention minimum, douze ordres par jour.');

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
--  Vérification : l'indice doit être revenu près de 1 000, aucune
--  société ne doit s'écarter de plus de quelques pour cent, et plus
--  personne ne doit avoir d'ordre compté aujourd'hui.
-- ---------------------------------------------------------------------
select public.bourse_indice() as indice,
       public.prix_indexe(350, 'commun')     as un_commun,
       public.prix_indexe(500, 'coffre')     as un_coffre,
       public.prix_indexe(1800,'legendaire') as un_legendaire;

select s.code, s.nom, s.prix_base,
       round(public.bourse_cours_actuel(s.code), 1) as cours,
       round((public.bourse_cours_actuel(s.code) / s.prix_base - 1) * 100, 1) as ecart_pct
  from public.bourse_societes s where s.actif
 order by abs(public.bourse_cours_actuel(s.code) / s.prix_base - 1) desc;

select p.name, p.gold,
       public.bourse_ordres_du_jour(p.id) as ordres_aujourdhui,
       (select count(*) from public.bourse_positions b where b.player_id = p.id) as positions
  from public.players p
 where p.alias_of is null
 order by p.gold desc;
