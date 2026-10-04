-- =====================================================================
--  CADENCE DU RELEVÉ : AUTOMATIQUE TOUTES LES 5 MINUTES,
--  À LA DEMANDE AU PLUS UNE FOIS PAR 90 SECONDES
--  À coller dans Supabase > SQL Editor > Run. Idempotent.
--
--  À relancer si tu l'avais déjà passé : l'étranglement y était à 240 s,
--  ce qui rendait inutile le bouton « Actualiser » du site.
-- =====================================================================

-- Deux choses différentes :
--   * le cron, toutes les 5 min, qui fait tourner le challenge tout seul ;
--   * l'étranglement, qui plafonne ce qu'un clic peut déclencher.
--
-- 30 s : le bouton « Actualiser » du site n'est jamais bloqué, et un
-- refus est si bref qu'il passe inaperçu. C'est ICI que se trouve le
-- vrai garde-fou, pas dans l'interface : dix joueurs qui martellent le
-- bouton ne déclenchent au plus qu'un relevé toutes les 30 s.
--
-- Le compte : un relevé coûte ~10 appels Riot en régime normal (un par
-- joueur), jusqu'à ~80 juste après une longue panne ; une clé de
-- développement en autorise 100 par 2 minutes. À un relevé par 30 s on
-- reste autour de 40 appels par 2 minutes — sous le plafond, avec de la
-- marge pour les rattrapages.
--
-- Si tu descends encore cette valeur, refais ce calcul : c'est elle qui
-- décide si le suivi tient ou se fait jeter par Riot en 429.
create or replace function public.riot_try_start_sync(p_force boolean default false)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  insert into public.sync_state (id) values (1) on conflict (id) do nothing;
  update public.sync_state
     set running_until = now() + interval '100 seconds', last_run = now()
   where id = 1
     and (running_until is null or running_until < now())
     and (p_force or last_run is null or last_run < now() - interval '30 seconds')
  returning true into ok;
  return coalesce(ok, false);
end $$;

revoke all on function public.riot_try_start_sync(boolean) from public, anon, authenticated;
grant execute on function public.riot_try_start_sync(boolean) to service_role;

-- Reprogrammation de la tâche
select cron.unschedule(jobid) from cron.job where jobname = 'riot-sync';

select cron.schedule('riot-sync', '*/5 * * * *', $cron$
  select net.http_post(
    url := 'https://krdohsbydwvuyoegbsub.supabase.co/functions/v1/riot',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "sync"}'::jsonb,
    timeout_milliseconds := 60000
  );
$cron$);

-- Vérifications
select jobid, jobname, schedule, active from cron.job where jobname = 'riot-sync';

-- Les 10 derniers déclenchements : utile pour voir si la tâche tourne
-- et ce que la fonction a répondu.
select status, return_message, start_time
  from cron.job_run_details
 where jobid in (select jobid from cron.job where jobname = 'riot-sync')
 order by start_time desc
 limit 10;
