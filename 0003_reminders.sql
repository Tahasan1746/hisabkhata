-- হিসাবখাতা · migration 0003 — reminder architecture (Telegram phase, designed now, sender comes next)
-- Design rules:
--   * The Telegram bot TOKEN is never stored in any table and never sent to a browser.
--     It lives only in the server environment of the scheduled job.
--   * Reminders are computed from cloud data by a scheduled server job, so they fire even when the app is closed.
--     That is why cloud sync must be reliable: the job can only remind about what is in the cloud.
--   * Dedupe is enforced by the database (unique key), so a retried job cannot send the same reminder twice.

-- ============================================================ where to deliver
create table if not exists public.notification_channels (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  channel      text not null check (channel in ('telegram')),
  destination  text not null check (char_length(destination) between 1 and 40),  -- e.g. Telegram chat id (not a secret)
  enabled      boolean not null default true,
  verified_at  timestamptz,                                                       -- set after a test message succeeds
  created_at   timestamptz not null default now(),
  unique (user_id, channel)
);

alter table public.notification_channels enable row level security;
drop policy if exists channels_all on public.notification_channels;
create policy channels_all on public.notification_channels for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.notification_channels to authenticated;

-- ============================================================ what was sent (dedupe log)
-- event_kind: 'upcoming' and 'today' are sent once per due date.
--             'overdue' is sent once per day (sent_on), so the daily nudge does not duplicate within a day.
create table if not exists public.reminder_deliveries (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  transaction_id  uuid not null references public.transactions (id) on delete cascade,
  channel         text not null check (channel in ('telegram')),
  event_kind      text not null check (event_kind in ('upcoming', 'today', 'overdue')),
  due_date        date not null,
  sent_on         date not null,
  created_at      timestamptz not null default now(),
  unique (transaction_id, channel, event_kind, due_date, sent_on)
);

alter table public.reminder_deliveries enable row level security;
drop policy if exists deliveries_select on public.reminder_deliveries;
create policy deliveries_select on public.reminder_deliveries for select to authenticated
  using (user_id = auth.uid());
grant select on public.reminder_deliveries to authenticated;
-- No client write policy: only the service role (the scheduled job) inserts here.

-- ============================================================ due candidates (service role only)
-- Returns what needs a reminder today. The job then (1) checks reminder_deliveries, (2) sends, (3) inserts a row.
create or replace function public.due_reminder_candidates(p_today date, p_window_days int default 3)
returns table (
  user_id           uuid,
  transaction_id    uuid,
  person_name       text,
  loan_type         text,
  remaining_paisa   bigint,
  due_date          date,
  event_kind        text,
  chat_destinations text[]
)
language sql stable security definer set search_path = public as $$
  select lr.user_id,
         lr.id,
         p.name,
         lr.type,
         lr.remaining_paisa,
         lr.due_date,
         case when lr.due_date < p_today then 'overdue'
              when lr.due_date = p_today then 'today'
              else 'upcoming' end,
         array(select nc.destination
                 from public.notification_channels nc
                where nc.user_id = lr.user_id and nc.channel = 'telegram' and nc.enabled)
    from public.loan_remaining lr
    join public.people p on p.id = lr.person_id and p.user_id = lr.user_id and p.deleted_at is null
   where lr.remaining_paisa > 0
     and lr.due_date is not null
     and lr.due_date <= p_today + p_window_days;
$$;

revoke all on function public.due_reminder_candidates(date, int) from public, anon, authenticated;
grant execute on function public.due_reminder_candidates(date, int) to service_role;
