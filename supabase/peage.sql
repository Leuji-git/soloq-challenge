-- =====================================================================
--  peage.sql — les fiches disent la vérité, et le Péage paye vraiment
--
--  TROIS CORRECTIONS
--
--  1. Baron Nashor annonçait « +15 LP », le code en donne 25. C'est 25.
--  2. Isolement annonçait « la partie ne compte pas », le code applique
--     −15 LP. Ce sont −15 LP.
--  3. Péage annonçait que les 20 LP arrachés partaient dans l'équipe de
--     celui qui l'a posé. En vérité ils s'évaporaient : la victime les
--     perdait, personne ne les touchait. Ils sont maintenant crédités.
--
--  LE RATTRAPAGE
--  Les Péages déjà joués ont bien coûté à leurs victimes, mais n'ont
--  jamais rien rapporté. Ce script pose le crédit manquant, daté du
--  moment où l'objet a agi — pas d'aujourd'hui, sinon les courbes
--  mentiraient. L'index unique (player_id, match_id) rend l'opération
--  rejouable sans rien doubler.
--
--  COMMENT ON CRÉDITE
--  Une ligne de partie à lp = 0 et lp_items = +20, exactement comme les
--  25 LP de la boutique : le score d'ÉQUIPE les prend, le classement
--  individuel ne bouge pas. Le classement reste du pur LP Riot.
--
--  À lancer après objets-effets.sql et boutique-v2.sql. Idempotent.
-- =====================================================================

-- Un nouveau genre de ligne, pour ne pas confondre un péage encaissé
-- avec un achat en boutique dans l'historique.
alter table public.games drop constraint if exists games_kind_valid;
do $$ begin
  alter table public.games add constraint games_kind_valid
    check (kind in ('game','adjust','shop','peage'));
exception when duplicate_object then null; end $$;


update public.items set
  effect = 'Si tu gagnes cette partie : +25 LP.'
 where key = 'baron_nashor';

update public.items set
  effect = 'Si ta cible joue sa prochaine partie en duo : −15 LP.'
 where key = 'isolement';

update public.items set
  effect = 'Si ta cible gagne sa prochaine partie, ses 20 premiers LP partent au score de ton équipe.'
 where key = 'peage';


-- ---------------------------------------------------------------------
--  Le rattrapage des péages déjà joués
-- ---------------------------------------------------------------------
insert into public.games
  (player_id, lp, lp_items, win, duo, kind, match_id, played_on, created_at, created_by)
select pi.player_id,
       0,
       -pi.lp_effect,
       true,
       'solo',
       'peage',
       pi.applied_match || '-peage',
       ((pi.used_at at time zone 'Europe/Paris')::date),
       pi.used_at,
       null
  from public.player_items pi
 where pi.item_key = 'peage'
   and pi.used_at is not null
   and pi.applied_match is not null
   and coalesce(pi.lp_effect, 0) < 0
on conflict do nothing;


notify pgrst, 'reload schema';

-- Ce que le rattrapage a rendu, et à qui.
select p.name, p.team, count(*) as peages, sum(g.lp_items) as lp_rendus
  from public.games g
  join public.players p on p.id = g.player_id
 where g.kind = 'peage'
 group by p.name, p.team
 order by lp_rendus desc;
