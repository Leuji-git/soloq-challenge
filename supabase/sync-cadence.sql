-- =====================================================================
--  CADENCE DU RELEVÉ : TOUTES LES 5 MINUTES
--  À coller dans Supabase > SQL Editor > Run. Idempotent.
--
--  À lancer si `riot-api.sql` a déjà été passé : il avait programmé le
--  relevé toutes les 3 minutes. Ce script le repasse à 5 minutes et
--  desserre l'étranglement en conséquence.
-- =====================================================================

-- L'étranglement doit rester SOUS la période du cron, sinon un relevé
-- sur deux serait refusé. 4 min pour un cron de 5 min.
create or replace function public.riot_try_start_sync(p_force boolean default false)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  insert into public.sync_state (id) values (1) on conflict (id) do nothing;
  update public.sync_state
     set running_until = now() + interval '100 seconds', last_run = now()
   where id = 1
     and (running_until is null or running_until < now())
     and (p_force or last_run is null or last_run < now() - interval '240 seconds')
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
