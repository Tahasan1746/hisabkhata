-- হিসাবখাতা · migration 0001 — core schema, integrity rules, Row Level Security
-- Run in Supabase: SQL Editor (paste the whole file) or `supabase db push`.
-- Money is bigint paisa (৳1 = 100). Dates are date. Every row carries user_id and RLS is enforced.
-- Clients never hard-delete financial rows: they are soft-deleted (deleted_at), which lets other devices sync the deletion.

create extension if not exists pgcrypto;

-- ============================================================ profiles
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  created_at   timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================ people
create table if not exists public.people (
  id          uuid primary key,                      -- client-generated UUID, stable across devices
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  phone       text not null default '' check (phone ~ '^(\+?[0-9-]{7,20})?$'),
  notes       text not null default '' check (char_length(notes) <= 500),
  archived    boolean not null default false,
  version     integer not null default 1 check (version >= 1),   -- optimistic concurrency token
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,                            -- tombstone
  unique (id, user_id)                                -- lets transactions reference (person, owner) together
);
create index if not exists people_user_updated_idx on public.people (user_id, updated_at);

-- ============================================================ transactions
create table if not exists public.transactions (
  id           uuid primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  person_id    uuid not null,
  type         text not null check (type in ('lent', 'borrowed', 'received', 'paid')),
  amount_paisa bigint not null check (amount_paisa > 0 and amount_paisa <= 100000000000),
  txn_date     date not null,
  due_date     date,
  category     text not null default 'অন্যান্য' check (char_length(category) <= 30),
  note         text not null default '' check (char_length(note) <= 300),
  voided       boolean not null default false,
  audit        jsonb not null default '[]'::jsonb check (jsonb_typeof(audit) = 'array'),
  version      integer not null default 1 check (version >= 1),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint txn_person_owner_fk foreign key (person_id, user_id)
    references public.people (id, user_id) on delete restrict,
  constraint txn_due_after_date check (due_date is null or due_date >= txn_date),
  constraint txn_due_only_loans check (due_date is null or type in ('lent', 'borrowed'))
);
create index if not exists txn_user_person_idx on public.transactions (user_id, person_id, type);
create index if not exists txn_user_updated_idx on public.transactions (user_id, updated_at);

-- ============================================================ triggers
-- Every update bumps the version and server-side updated_at (the server clock is authoritative).
create or replace function public.bump_version()
returns trigger language plpgsql set search_path = public as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists people_bump on public.people;
create trigger people_bump before update on public.people
  for each row execute function public.bump_version();

drop trigger if exists txn_bump on public.transactions;
create trigger txn_bump before update on public.transactions
  for each row execute function public.bump_version();

-- Ledger rule, enforced on the server so no client (or race between devices) can overdraw a balance.
-- Deferred: checked at commit. sync_push switches it to IMMEDIATE per change so each bad change fails alone.
create or replace function public.enforce_ledger()
returns trigger language plpgsql security invoker set search_path = public as $$
declare
  v_recv bigint; v_lent bigint; v_paid bigint; v_borrowed bigint;
begin
  -- serialise concurrent writes for the same person
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || ':' || new.person_id::text, 0));

  select coalesce(sum(amount_paisa) filter (where type = 'received'), 0),
         coalesce(sum(amount_paisa) filter (where type = 'lent'), 0),
         coalesce(sum(amount_paisa) filter (where type = 'paid'), 0),
         coalesce(sum(amount_paisa) filter (where type = 'borrowed'), 0)
    into v_recv, v_lent, v_paid, v_borrowed
    from public.transactions
   where user_id = new.user_id and person_id = new.person_id
     and not voided and deleted_at is null;

  if v_recv > v_lent then
    raise exception 'LEDGER: বাকি পাওনার চেয়ে বেশি গ্রহণ করা যাবে না' using errcode = 'check_violation';
  end if;
  if v_paid > v_borrowed then
    raise exception 'LEDGER: বাকি দেনার চেয়ে বেশি পরিশোধ করা যাবে না' using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists transactions_ledger on public.transactions;
create constraint trigger transactions_ledger
  after insert or update on public.transactions
  deferrable initially deferred
  for each row execute function public.enforce_ledger();

-- ============================================================ row level security
alter table public.profiles     enable row level security;
alter table public.people       enable row level security;
alter table public.transactions enable row level security;

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists people_select on public.people;
drop policy if exists people_insert on public.people;
drop policy if exists people_update on public.people;
create policy people_select on public.people for select to authenticated using (user_id = auth.uid());
create policy people_insert on public.people for insert to authenticated with check (user_id = auth.uid());
create policy people_update on public.people for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists txn_select on public.transactions;
drop policy if exists txn_insert on public.transactions;
drop policy if exists txn_update on public.transactions;
create policy txn_select on public.transactions for select to authenticated using (user_id = auth.uid());
create policy txn_insert on public.transactions for insert to authenticated with check (user_id = auth.uid());
create policy txn_update on public.transactions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- No DELETE policy and no DELETE privilege for clients: soft delete only.
-- anon gets nothing at all.
revoke all on all tables in schema public from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.people, public.transactions to authenticated;
