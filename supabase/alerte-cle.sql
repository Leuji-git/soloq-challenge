-- =====================================================================
--  alerte-cle.sql — prévenir le Discord quand la clé Riot meurt
--
--  Une clé de développement vit 24 h. Le vrai problème n'est pas de la
--  remplacer, c'est de s'apercevoir qu'elle est morte : sans alerte, le
--  suivi s'arrête en silence et personne ne le voit avant le soir.
--
--  Ce script ajoute de quoi n'annoncer la panne qu'une fois par heure,
--  même si le relevé tourne toutes les 5 minutes.
--  Idempotent : le relancer ne casse rien.
-- =====================================================================

alter table public.sync_state add column if not exists key_down_since timestamptz;
alter table public.sync_state add column if not exists key_alert_at   timestamptz;

-- Réclame le droit d'annoncer un changement d'état de la clé.
-- Renvoie 'panne' ou 'retablie' une seule fois, puis null : c'est ce
-- verrou qui empêche les 12 relevés d'une heure de spammer le salon.
create or replace function public.riot_claim_key_alert(p_down boolean)
returns text language plpgsql security definer set search_path = public as $$
declare etat text;
begin
  if p_down then
    -- key_down_since garde l'heure du début de panne, même après
    -- plusieurs rappels : c'est ce qui permet de dire « depuis 3 h ».
    update public.sync_state
       set key_down_since = coalesce(key_down_since, now()),
           key_alert_at   = now()
     where id = 1
       and (key_alert_at is null or key_alert_at < now() - interval '60 minutes')
    returning 'panne' into etat;
  else
    -- On n'annonce le retour que si une panne était en cours.
    update public.sync_state
       set key_down_since = null,
           key_alert_at   = null
     where id = 1
       and key_down_since is not null
    returning 'retablie' into etat;
  end if;
  return etat;
end $$;

revoke all     on function public.riot_claim_key_alert(boolean) from public, anon, authenticated;
grant  execute on function public.riot_claim_key_alert(boolean) to service_role;

-- La policy de lecture de sync_state couvre déjà les nouvelles colonnes :
-- la console admin les voit sans rien de plus.
select key_down_since, key_alert_at, last_error from public.sync_state where id = 1;
