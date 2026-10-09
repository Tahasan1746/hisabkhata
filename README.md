# হিসাবখাতা — ব্যক্তিগত পাওনা-দেনার হিসাব (v2: cloud sync)

Bangla-first personal ledger. It is an installable web app (PWA) that works offline.
Data lives on the device first (IndexedDB). With a Supabase project configured, it syncs to the cloud
and can be restored on another device. Without it, the app runs exactly as the local-only version.

## Files

```
hisabkhata/
├── index.html · styles.css · app.js        UI, ledger, screens (behaviour unchanged from v1)
├── sync-core.js                            pure sync engine (no DOM, no network), tested
├── cloud.js                                Supabase auth, sync scheduling, status, cloud backup/restore
├── config.js                               PUBLIC config: Project URL + anon key (empty = local-only)
├── sw.js · manifest.json · icon.svg        offline shell and install metadata
├── supabase/
│   ├── migrations/0001_schema.sql          tables, integrity rules, server-side ledger rule, RLS
│   ├── migrations/0002_sync_api.sql        sync_push / sync_pull / sync_replace_all, backups, FIFO view
│   ├── migrations/0003_reminders.sql       Telegram-phase design: channels, dedupe log, due-candidate function
│   └── tests/rls_and_sync.sql              database tests (run on a disposable project)
├── scripts/build-config.mjs                Vercel build step: writes config.js from env vars, refuses secrets
├── tests/sync-core.test.js                 23 tests: sync engine (offline, restore, retries, conflicts, isolation)
├── tests/app-smoke.test.js                11 tests: real app.js/cloud.js in a sandbox (screens, saves, reset, validation)
└── .env.example · package.json · README.md
```

## How it works

- **Local first.** Every change is saved to IndexedDB immediately and marked "not yet in the cloud".
  Nothing waits for the network.
- **Sync** runs after sign-in, about one second after a change, every minute while the app is open,
  when the connection returns, and when you come back to the app. It uploads pending changes in batches,
  then downloads what changed on other devices.
- **Versions, not timestamps.** Each record has a server version. An update is accepted only if the device
  is editing the version it last saw. If another device changed it first, you get a **conflict**: both copies
  are kept and you choose which one to keep. Nothing is overwritten silently.
- **Retries are safe.** If a response is lost, the same change can be sent again. The server recognises identical
  content and does not create a duplicate.
- **The ledger rule is enforced on the server too.** A repayment larger than what is owed is rejected, even
  if two devices try at the same time.
- **Deletes sync as tombstones** (soft delete). "সব তথ্য মুছুন" on one device removes the data on the others.
- **Status indicator** (dashboard and Settings): সিঙ্ক হয়েছে · সিঙ্ক হচ্ছে · অফলাইন · সিঙ্ক ব্যর্থ, plus
  "শুধু এই ডিভাইসে" when you are not signed in.

## Setup

### 1. Create a Supabase project
Supabase dashboard → New project. Note the **Project URL** and the **anon / publishable** key
(Project Settings → API). Never copy the **service_role** key or any "secret" key into this project.

### 2. Run the migrations in order
SQL Editor → paste each file, then Run:
1. `supabase/migrations/0001_schema.sql`
2. `supabase/migrations/0002_sync_api.sql`
3. `supabase/migrations/0003_reminders.sql`

(With the Supabase CLI, copy the files into `supabase/migrations/` with timestamp names and run `supabase db push`.)

### 3. Authentication settings
Authentication → URL Configuration:
- **Site URL:** your Vercel address, e.g. `https://hisabkhata.vercel.app`
- **Redirect URLs:** add the same address (password reset and email confirmation return here).

Authentication → Providers → Email: keep "Confirm email" on, so a new account must verify its address.

### 4. Enter the public values (choose one)
- **Local testing:** open `config.js` and paste the URL and the anon key between the quotes.
- **Vercel (recommended):** Project → Settings → Environment Variables, add
  `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The build step writes `config.js` from them.
  Do **not** add `SUPABASE_SERVICE_ROLE_KEY` or `TELEGRAM_BOT_TOKEN` to this project.

### 5. Deploy
- GitHub: push this folder to a repository.
- Vercel: Add New → Project → import the repository. Framework preset: **Other**.
  Build command: `node scripts/build-config.mjs`. Output directory: `.`
- Open the Vercel address on your phone → Chrome menu → **Install app**.

## Tests

```bash
npm test          # 34 tests in total
                  #   23 sync engine: offline recovery, cross-device restore, retries, conflicts, ledger rejection,
                  #                   user isolation, deletes, replace-all, key safety, checksums
                  #   11 browser paths: dashboard/settings/backup render, dirty marking, over-repayment refusal,
                  #                     reset tombstones, JSON validation, offline-only start, key refusal
```

Database tests (RLS isolation, server ledger rule, stale-version conflicts, idempotent retries, replace rollback,
private backups, reminder function locked to the service role):

1. Create a **separate, disposable** Supabase project (or a branch). Do not run this on real data.
2. Run migrations 0001–0003 first.
3. SQL Editor → paste `supabase/tests/rls_and_sync.sql` → Run. Every check prints `PASS:`; a failure
   stops with `TEST FAILED: <name>`. The whole script runs in one transaction and rolls back.

Manual checklist on a real project:
- [ ] Sign up, confirm the email, sign in. The pill shows "সিঙ্ক হয়েছে".
- [ ] Add a person and a loan offline (airplane mode). The pill shows "অফলাইন" with the pending count.
- [ ] Turn the connection back on. Pending changes upload; the count drops to zero.
- [ ] Sign in on a second device with the same account. Everything appears.
- [ ] Edit the same loan on both devices (one offline). The stale device shows a conflict; resolve it.
- [ ] Create a cloud backup. The list shows it with the record count. Restore it after a confirmation.
- [ ] Sign in with a different account on a device that has data. The app refuses and explains why.
- [ ] Export and import the JSON file as before; it still works.

## Security notes

- The browser holds only the Project URL and the public anon/publishable key. Access is limited by RLS:
  every table is filtered by `user_id = auth.uid()`, clients cannot hard-delete, and anon has no access.
- `scripts/build-config.mjs` and the app both refuse service-role or secret keys.
- Supabase sessions are kept in the browser's storage by the Supabase client (standard behaviour).
  Passwords are never stored in the app.
- The service worker caches the app shell and public libraries only. It does not cache Supabase responses,
  so financial data is not kept in the offline cache.
- Cloud backups hold your financial data in your own database, protected by RLS but not encrypted at the
  application level. Keep the Supabase account secure (strong password, 2FA).

## Limitations (honest list)

- **Verified here (Node 22):** the sync engine and the browser code paths (34 tests), the build script, and JavaScript syntax.
  **Not verified here:** the SQL migrations and the RLS tests, which need a Postgres/Supabase instance,
  and the browser flows (sign-up, email links, install prompt), which need a live project.
  Run `supabase/tests/rls_and_sync.sql` before relying on the cloud.
- **Two devices adding the same loan separately** create two records. Sync cannot tell they are the same
  debt. Edit one and delete the other.
- **Clock:** ordering uses the server clock. The client re-reads a 2-minute overlap window so late-committed
  rows are not missed; this is not a guarantee for very long transactions.
- **Large histories:** the first sync is sent in batches of 100, and a pull comes back as one response.
  Very large ledgers (tens of thousands of rows) would need pagination.
- **Reminders while closed:** the browser notifications from v1 only fire while the app runs.
  Reminders with the app fully closed come from the server job (next phase).
- **Conflict resolution** is manual by design. "Latest wins" would silently discard a financial edit.
- **Restore and JSON replace while signed in** change the cloud data and need an internet connection.
  Offline, you can merge a file but not replace.
- Supabase free tier pauses inactive projects; check your plan limits for production use.

## Telegram reminders: the next phase (designed, not yet built)

Migration `0003_reminders.sql` is in place:
- `notification_channels` stores where to send reminders (a Telegram chat id, which is not a secret). It holds no token.
- `reminder_deliveries` is a dedupe log with a unique key, so a retried job cannot send the same reminder twice.
- `due_reminder_candidates(today, window)` lists what is due. It is callable only by the **service role**.
  The `loan_remaining` view computes balances with the same FIFO rule as the app.

The next step is a scheduled server function (Vercel Cron or a Supabase scheduled function):
1. Call `due_reminder_candidates` with the service-role key, which lives only in that server's environment.
2. For each row not yet in `reminder_deliveries`, send a message through the Telegram Bot API using
   `TELEGRAM_BOT_TOKEN`, which is also stored only on the server.
3. Insert the delivery row, so the next run skips it.

Because the job reads cloud data, reminders depend on reliable sync. That is why the sync layer comes first.
