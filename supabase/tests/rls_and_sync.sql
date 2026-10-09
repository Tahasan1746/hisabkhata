-- হিসাবখাতা · database tests
-- Run ONLY on a disposable Supabase project or branch (it creates two test users).
-- Everything is inside one transaction and rolled back at the end, so nothing persists.
-- Usage: paste into the SQL Editor, or `psql "$DB_URL" -f supabase/tests/rls_and_sync.sql`.
-- A failed assertion raises an exception with the test name.

begin;

-- ---------- helpers ----------------------------------------------------------
create or replace function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;

create or replace function pg_temp.as_admin() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

create or replace function pg_temp.assert_true(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'TEST FAILED: %', p_name;
  end if;
  raise notice 'PASS: %', p_name;
end $$;

-- ---------- fixtures ---------------------------------------------------------
-- Test users. Adjust the insert if your auth.users requires more columns.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice-test@example.invalid'),
  ('22222222-2222-4222-8222-222222222222', 'bob-test@example.invalid');

-- ---------- 1. user isolation (RLS) -----------------------------------------
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select public.sync_push(jsonb_build_array(jsonb_build_object(
  'kind', 'person', 'id', 'aaaaaaaa-0000-4000-8000-000000000001', 'op', 'upsert', 'expected', 0,
  'data', jsonb_build_object('name', 'রহিম', 'phone', '', 'notes', '', 'archived', false))));
select pg_temp.assert_true('alice can read her own person',
  (select count(*) from public.people) = 1);

select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select pg_temp.assert_true('bob cannot see alice rows',
  (select count(*) from public.people) = 0);

-- bob tries to overwrite alice's person through sync_push
select public.sync_push(jsonb_build_array(jsonb_build_object(
  'kind', 'person', 'id', 'aaaaaaaa-0000-4000-8000-000000000001', 'op', 'upsert', 'expected', 1,
  'data', jsonb_build_object('name', 'হ্যাক', 'phone', '', 'notes', '', 'archived', false))));
select pg_temp.as_admin();
select pg_temp.assert_true('bob cannot modify alice person',
  (select name from public.people where id = 'aaaaaaaa-0000-4000-8000-000000000001') = 'রহিম');

-- bob cannot insert a row claiming alice's user_id
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
do $$
begin
  begin
    insert into public.people (id, user_id, name) values
      ('bbbbbbbb-0000-4000-8000-000000000009', '11111111-1111-4111-8111-111111111111', 'spoof');
    raise exception 'TEST FAILED: spoofed user_id insert was allowed';
  exception when insufficient_privilege or check_violation then
    raise notice 'PASS: spoofed user_id insert is blocked';
  end;
end $$;

-- ---------- 2. no hard deletes by clients -----------------------------------
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
do $$
begin
  begin
    delete from public.people where id = 'aaaaaaaa-0000-4000-8000-000000000001';
    raise exception 'TEST FAILED: client hard delete was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS: client hard delete is blocked';
  end;
end $$;

-- ---------- 3. ledger rule on the server --------------------------------------
select public.sync_push(jsonb_build_array(jsonb_build_object(
  'kind', 'txn', 'id', 'aaaaaaaa-0000-4000-8000-000000000101', 'op', 'upsert', 'expected', 0,
  'data', jsonb_build_object('person_id', 'aaaaaaaa-0000-4000-8000-000000000001', 'type', 'lent',
    'amount_paisa', 500000, 'txn_date', '2026-10-01', 'due_date', null, 'category', 'ব্যক্তিগত',
    'note', '', 'voided', false, 'audit', '[]'::jsonb))));

-- a valid ৳2,000 repayment first
select public.sync_push(jsonb_build_array(jsonb_build_object(
  'kind', 'txn', 'id', 'aaaaaaaa-0000-4000-8000-000000000103', 'op', 'upsert', 'expected', 0,
  'data', jsonb_build_object('person_id', 'aaaaaaaa-0000-4000-8000-000000000001', 'type', 'received',
    'amount_paisa', 200000, 'txn_date', '2026-10-03', 'due_date', null, 'category', 'ব্যক্তিগত',
    'note', '', 'voided', false, 'audit', '[]'::jsonb))));

-- then a ৳6,000 repayment: 2,000 + 6,000 > 5,000 loan, so the server must reject it
select public.sync_push(jsonb_build_array(jsonb_build_object(
  'kind', 'txn', 'id', 'aaaaaaaa-0000-4000-8000-000000000102', 'op', 'upsert', 'expected', 0,
  'data', jsonb_build_object('person_id', 'aaaaaaaa-0000-4000-8000-000000000001', 'type', 'received',
    'amount_paisa', 600000, 'txn_date', '2026-10-02', 'due_date', null, 'category', 'ব্যক্তিগত',
    'note', '', 'voided', false, 'audit', '[]'::jsonb))));
select pg_temp.as_admin();
select pg_temp.assert_true('over-repayment is not stored',
  not exists (select 1 from public.transactions where id = 'aaaaaaaa-0000-4000-8000-000000000102'));
select pg_temp.assert_true('FIFO remaining is ৳3,000 after a ৳2,000 repayment',
  (select remaining_paisa from public.loan_remaining where id = 'aaaaaaaa-0000-4000-8000-000000000101') = 300000);

-- ---------- 4. stale version => conflict, identical retry => ok ---------------
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select public.sync_push(jsonb_build_array(jsonb_build_object(
  'kind', 'person', 'id', 'aaaaaaaa-0000-4000-8000-000000000001', 'op', 'upsert', 'expected', 1,
  'data', jsonb_build_object('name', 'রহিম (আপডেট)', 'phone', '', 'notes', '', 'archived', false))));
-- second device still holds version 1 -> conflict
select pg_temp.assert_true('stale expected version is reported as conflict',
  (select r->>'status' from jsonb_array_elements(public.sync_push(jsonb_build_array(jsonb_build_object(
     'kind', 'person', 'id', 'aaaaaaaa-0000-4000-8000-000000000001', 'op', 'upsert', 'expected', 1,
     'data', jsonb_build_object('name', 'রহিম (অন্য ডিভাইস)', 'phone', '', 'notes', '', 'archived', false))))) r)
  = 'conflict');
-- identical content retried with the old version => ok, no duplicate
select pg_temp.assert_true('identical retry is idempotent',
  (select r->>'status' from jsonb_array_elements(public.sync_push(jsonb_build_array(jsonb_build_object(
     'kind', 'person', 'id', 'aaaaaaaa-0000-4000-8000-000000000001', 'op', 'upsert', 'expected', 1,
     'data', jsonb_build_object('name', 'রহিম (আপডেট)', 'phone', '', 'notes', '', 'archived', false))))) r)
  = 'ok');

-- ---------- 5. pull and tombstones --------------------------------------------
select pg_temp.assert_true('pull returns changes after the cursor',
  jsonb_array_length((public.sync_pull('1970-01-01'::timestamptz))->'people') >= 1);

-- ---------- 6. replace-all restores exactly the payload -------------------------
select public.sync_replace_all(
  jsonb_build_array(jsonb_build_object('id', 'aaaaaaaa-0000-4000-8000-000000000001', 'name', 'রহিম', 'phone', '',
                                       'notes', '', 'archived', false)),
  '[]'::jsonb);
select pg_temp.as_admin();
select pg_temp.assert_true('replace-all soft-deletes transactions not in the payload',
  (select count(*) from public.transactions where id = 'aaaaaaaa-0000-4000-8000-000000000101' and deleted_at is null) = 0);

-- ---------- 7. backups are private --------------------------------------------
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
insert into public.cloud_backups (record_count, checksum, payload)
values (1, repeat('a', 64), '{"app":"hisabkhata","version":1}'::jsonb);
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select pg_temp.assert_true('bob cannot list alice backups',
  (select count(*) from public.cloud_backups) = 0);

-- ---------- 8. reminder function is service-role only ---------------------------
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
do $$
begin
  begin
    perform * from public.due_reminder_candidates(current_date, 3);
    raise exception 'TEST FAILED: authenticated user could call the reminder job';
  exception when insufficient_privilege then
    raise notice 'PASS: reminder job is not callable by app users';
  end;
end $$;

select pg_temp.as_admin();
rollback;
