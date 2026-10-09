-- হিসাবখাতা · migration 0002 — sync API, cloud backups, loan view
-- Depends on 0001. All functions run as SECURITY INVOKER: RLS applies to every statement,
-- so a user can only ever touch their own rows, even if these functions are called directly.

-- ============================================================ per-record apply: people
-- Outcomes: {status:'ok', version} | {status:'conflict', server} | error raised to caller.
create or replace function public.apply_person(p_id uuid, p_expected int, p_op text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  cur public.people%rowtype;
  v_ver int;
begin
  select * into cur from public.people where id = p_id for update;

  if not found then
    -- (a row owned by someone else is invisible here; the insert below then fails on the primary key)
    if p_op = 'delete' then
      return jsonb_build_object('status', 'ok', 'version', 0);
    end if;
    if p_expected <> 0 then
      return jsonb_build_object('status', 'conflict', 'server', null);
    end if;
    insert into public.people (id, user_id, name, phone, notes, archived, created_at)
    values (p_id, auth.uid(), p_data->>'name', coalesce(p_data->>'phone', ''),
            coalesce(p_data->>'notes', ''), coalesce((p_data->>'archived')::boolean, false),
            coalesce((p_data->>'created_at')::timestamptz, now()));
    select version into v_ver from public.people where id = p_id;
    return jsonb_build_object('status', 'ok', 'version', v_ver);
  end if;

  if p_op = 'delete' then
    if cur.deleted_at is not null then
      return jsonb_build_object('status', 'ok', 'version', cur.version);
    end if;
    if cur.version <> p_expected then
      return jsonb_build_object('status', 'conflict', 'server', to_jsonb(cur));
    end if;
    update public.people set deleted_at = now() where id = p_id;
    select version into v_ver from public.people where id = p_id;
    return jsonb_build_object('status', 'ok', 'version', v_ver);
  end if;

  if cur.version = p_expected then
    update public.people set
      name = p_data->>'name',
      phone = coalesce(p_data->>'phone', ''),
      notes = coalesce(p_data->>'notes', ''),
      archived = coalesce((p_data->>'archived')::boolean, false),
      deleted_at = null
    where id = p_id;
    select version into v_ver from public.people where id = p_id;
    return jsonb_build_object('status', 'ok', 'version', v_ver);
  end if;

  -- version moved, but the content already matches: this is a retry after a lost response. Treat as success.
  if cur.deleted_at is null
     and cur.name = p_data->>'name'
     and cur.phone = coalesce(p_data->>'phone', '')
     and cur.notes = coalesce(p_data->>'notes', '')
     and cur.archived = coalesce((p_data->>'archived')::boolean, false) then
    return jsonb_build_object('status', 'ok', 'version', cur.version);
  end if;

  return jsonb_build_object('status', 'conflict', 'server', to_jsonb(cur));
end $$;

-- ============================================================ per-record apply: transactions
create or replace function public.apply_txn(p_id uuid, p_expected int, p_op text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  cur public.transactions%rowtype;
  v_ver int;
begin
  select * into cur from public.transactions where id = p_id for update;

  if not found then
    if p_op = 'delete' then
      return jsonb_build_object('status', 'ok', 'version', 0);
    end if;
    if p_expected <> 0 then
      return jsonb_build_object('status', 'conflict', 'server', null);
    end if;
    insert into public.transactions
      (id, user_id, person_id, type, amount_paisa, txn_date, due_date, category, note, voided, audit, created_at)
    values
      (p_id, auth.uid(), (p_data->>'person_id')::uuid, p_data->>'type', (p_data->>'amount_paisa')::bigint,
       (p_data->>'txn_date')::date, nullif(p_data->>'due_date', '')::date,
       coalesce(nullif(p_data->>'category', ''), 'অন্যান্য'), coalesce(p_data->>'note', ''),
       coalesce((p_data->>'voided')::boolean, false), coalesce(p_data->'audit', '[]'::jsonb),
       coalesce((p_data->>'created_at')::timestamptz, now()));
    select version into v_ver from public.transactions where id = p_id;
    return jsonb_build_object('status', 'ok', 'version', v_ver);
  end if;

  if p_op = 'delete' then
    if cur.deleted_at is not null then
      return jsonb_build_object('status', 'ok', 'version', cur.version);
    end if;
    if cur.version <> p_expected then
      return jsonb_build_object('status', 'conflict', 'server', to_jsonb(cur));
    end if;
    update public.transactions set deleted_at = now() where id = p_id;   -- ledger trigger re-checks the person
    select version into v_ver from public.transactions where id = p_id;
    return jsonb_build_object('status', 'ok', 'version', v_ver);
  end if;

  if cur.version = p_expected then
    update public.transactions set
      person_id    = (p_data->>'person_id')::uuid,
      type         = p_data->>'type',
      amount_paisa = (p_data->>'amount_paisa')::bigint,
      txn_date     = (p_data->>'txn_date')::date,
      due_date     = nullif(p_data->>'due_date', '')::date,
      category     = coalesce(nullif(p_data->>'category', ''), 'অন্যান্য'),
      note         = coalesce(p_data->>'note', ''),
      voided       = coalesce((p_data->>'voided')::boolean, false),
      audit        = coalesce(p_data->'audit', '[]'::jsonb),
      deleted_at   = null
    where id = p_id;
    select version into v_ver from public.transactions where id = p_id;
    return jsonb_build_object('status', 'ok', 'version', v_ver);
  end if;

  -- retry after a lost response: identical content counts as success
  if cur.deleted_at is null
     and cur.person_id = (p_data->>'person_id')::uuid
     and cur.type = p_data->>'type'
     and cur.amount_paisa = (p_data->>'amount_paisa')::bigint
     and cur.txn_date = (p_data->>'txn_date')::date
     and cur.due_date is not distinct from nullif(p_data->>'due_date', '')::date
     and cur.category = coalesce(nullif(p_data->>'category', ''), 'অন্যান্য')
     and cur.note = coalesce(p_data->>'note', '')
     and cur.voided = coalesce((p_data->>'voided')::boolean, false)
     and cur.audit = coalesce(p_data->'audit', '[]'::jsonb) then
    return jsonb_build_object('status', 'ok', 'version', cur.version);
  end if;

  return jsonb_build_object('status', 'conflict', 'server', to_jsonb(cur));
end $$;

-- ============================================================ batch push (one RPC call)
-- Each change runs in its own sub-transaction. A rejected change (conflict, ledger rule, bad data)
-- is reported back and does not roll back the others. Re-sending the same batch is safe.
create or replace function public.sync_push(p_changes jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  ch jsonb;
  res jsonb := '[]'::jsonb;
  r jsonb;
  v_kind text;
  v_id text;
  v_op text;
  v_exp int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 500 then
    raise exception 'BAD_BATCH' using errcode = '22023';
  end if;

  for ch in select value from jsonb_array_elements(p_changes) loop
    v_kind := ch->>'kind';
    v_id   := ch->>'id';
    v_op   := coalesce(ch->>'op', 'upsert');
    v_exp  := coalesce((ch->>'expected')::int, 0);
    begin
      set constraints public.transactions_ledger immediate;
      if v_kind = 'person' then
        r := public.apply_person(v_id::uuid, v_exp, v_op, ch->'data');
      elsif v_kind = 'txn' then
        r := public.apply_txn(v_id::uuid, v_exp, v_op, ch->'data');
      else
        raise exception 'BAD_KIND' using errcode = '22023';
      end if;
    exception when others then
      r := jsonb_build_object('status', 'error', 'code', sqlstate, 'message', sqlerrm);
    end;
    res := res || jsonb_build_array(jsonb_build_object('kind', v_kind, 'id', v_id) || r);
  end loop;

  return res;
end $$;

-- ============================================================ pull changes since a cursor
-- Returns rows changed after p_since, including tombstones. The client keeps an overlap window.
create or replace function public.sync_pull(p_since timestamptz)
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'server_time', now(),
    'people', coalesce((select jsonb_agg(to_jsonb(p) order by p.updated_at)
                          from public.people p where p.updated_at > p_since), '[]'::jsonb),
    'txns',   coalesce((select jsonb_agg(to_jsonb(t) order by t.updated_at)
                          from public.transactions t where t.updated_at > p_since), '[]'::jsonb)
  );
$$;

-- ============================================================ replace everything (restore / import)
-- Atomic: soft-deletes the user's current rows, then writes the payload. Deferred ledger check runs at commit,
-- so a payload that breaks the ledger rule rolls back completely.
create or replace function public.sync_replace_all(p_people jsonb, p_txns jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  p jsonb;
  t jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_people) <> 'array' or jsonb_typeof(p_txns) <> 'array' then
    raise exception 'BAD_PAYLOAD' using errcode = '22023';
  end if;

  update public.transactions set deleted_at = now() where deleted_at is null;
  update public.people set deleted_at = now() where deleted_at is null;

  for p in select value from jsonb_array_elements(p_people) loop
    insert into public.people (id, user_id, name, phone, notes, archived, created_at)
    values ((p->>'id')::uuid, auth.uid(), p->>'name', coalesce(p->>'phone', ''), coalesce(p->>'notes', ''),
            coalesce((p->>'archived')::boolean, false), coalesce((p->>'created_at')::timestamptz, now()))
    on conflict (id) do update set
      name = excluded.name, phone = excluded.phone, notes = excluded.notes,
      archived = excluded.archived, deleted_at = null;
  end loop;

  -- loans before repayments (purely for readability of the audit; the check is at commit)
  for t in select value from jsonb_array_elements(p_txns)
           order by case when value->>'type' in ('received', 'paid') then 1 else 0 end loop
    insert into public.transactions
      (id, user_id, person_id, type, amount_paisa, txn_date, due_date, category, note, voided, audit, created_at)
    values
      ((t->>'id')::uuid, auth.uid(), (t->>'person_id')::uuid, t->>'type', (t->>'amount_paisa')::bigint,
       (t->>'txn_date')::date, nullif(t->>'due_date', '')::date,
       coalesce(nullif(t->>'category', ''), 'অন্যান্য'), coalesce(t->>'note', ''),
       coalesce((t->>'voided')::boolean, false), coalesce(t->'audit', '[]'::jsonb),
       coalesce((t->>'created_at')::timestamptz, now()))
    on conflict (id) do update set
      person_id = excluded.person_id, type = excluded.type, amount_paisa = excluded.amount_paisa,
      txn_date = excluded.txn_date, due_date = excluded.due_date, category = excluded.category,
      note = excluded.note, voided = excluded.voided, audit = excluded.audit, deleted_at = null;
  end loop;

  return jsonb_build_object(
    'server_time', now(),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'version', version)), '[]'::jsonb)
                 from public.people where deleted_at is null),
    'txns',   (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'version', version)), '[]'::jsonb)
                 from public.transactions where deleted_at is null)
  );
end $$;

-- ============================================================ cloud backups
create table if not exists public.cloud_backups (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  record_count integer not null check (record_count >= 0),
  checksum     text not null check (char_length(checksum) = 64),   -- SHA-256 of the canonical JSON
  payload      jsonb not null check (jsonb_typeof(payload) = 'object'),
  app_version  integer not null default 1
);
create index if not exists cloud_backups_user_idx on public.cloud_backups (user_id, created_at desc);

-- keep the newest 20 per user
create or replace function public.prune_cloud_backups()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  delete from public.cloud_backups
   where user_id = new.user_id
     and id not in (select id from public.cloud_backups
                     where user_id = new.user_id
                     order by created_at desc limit 20);
  return null;
end $$;

drop trigger if exists cloud_backups_prune on public.cloud_backups;
create trigger cloud_backups_prune after insert on public.cloud_backups
  for each row execute function public.prune_cloud_backups();

alter table public.cloud_backups enable row level security;
drop policy if exists backups_select on public.cloud_backups;
drop policy if exists backups_insert on public.cloud_backups;
drop policy if exists backups_delete on public.cloud_backups;
create policy backups_select on public.cloud_backups for select to authenticated using (user_id = auth.uid());
create policy backups_insert on public.cloud_backups for insert to authenticated with check (user_id = auth.uid());
create policy backups_delete on public.cloud_backups for delete to authenticated using (user_id = auth.uid());
grant select, insert, delete on public.cloud_backups to authenticated;

-- ============================================================ FIFO loan balances (server copy of the client rule)
-- Repayments are pooled per person and applied oldest loan first, exactly like the app's ledger().
-- Used by the reminder job (migration 0003) and by reports. security_invoker: RLS still applies.
create or replace view public.loan_remaining with (security_invoker = true) as
with live as (
  select * from public.transactions where deleted_at is null and not voided
),
loans as (
  select l.*,
         coalesce(sum(l.amount_paisa) over (
           partition by l.user_id, l.person_id, l.type
           order by l.txn_date, l.created_at, l.id
           rows between unbounded preceding and 1 preceding), 0) as cum_before
  from live l
  where l.type in ('lent', 'borrowed')
),
repaid as (
  select user_id, person_id, type, sum(amount_paisa) as total
  from live
  where type in ('received', 'paid')
  group by user_id, person_id, type
)
select loans.id,
       loans.user_id,
       loans.person_id,
       loans.type,
       loans.amount_paisa,
       loans.txn_date,
       loans.due_date,
       greatest(0, least(loans.amount_paisa, coalesce(r.total, 0) - loans.cum_before)) as repaid_paisa,
       loans.amount_paisa
         - greatest(0, least(loans.amount_paisa, coalesce(r.total, 0) - loans.cum_before)) as remaining_paisa
from loans
left join repaid r
  on r.user_id = loans.user_id
 and r.person_id = loans.person_id
 and r.type = case when loans.type = 'lent' then 'received' else 'paid' end;

-- ============================================================ privileges for the functions
revoke all on function
  public.apply_person(uuid, int, text, jsonb),
  public.apply_txn(uuid, int, text, jsonb),
  public.sync_push(jsonb),
  public.sync_pull(timestamptz),
  public.sync_replace_all(jsonb, jsonb)
from public, anon;

-- apply_* are called inside sync_push, which runs as the signed-in user, so authenticated needs EXECUTE.
grant execute on function
  public.apply_person(uuid, int, text, jsonb),
  public.apply_txn(uuid, int, text, jsonb),
  public.sync_push(jsonb),
  public.sync_pull(timestamptz),
  public.sync_replace_all(jsonb, jsonb)
to authenticated;

grant select on public.loan_remaining to authenticated;
