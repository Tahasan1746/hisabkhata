/* হিসাবখাতা · cloud layer — Supabase auth, sync scheduling, status, cloud backup/restore.
 * Local IndexedDB stays the primary store. With no config the app behaves exactly as before.
 * Only the public anon/publishable key is ever used here; protection is RLS on the server. */
(function () {
  'use strict';

  const Core = window.HisabSync;
  const cfg = window.HISAB_CONFIG || {};
  const MIN_PASSWORD = 8;

  let client = null;          // supabase-js client (null until configured and the library has loaded)
  let user = null;            // signed-in Supabase user, if any
  let running = false;        // a sync run is in progress
  let rerun = false;          // a change arrived during a run: run again afterwards
  let debounce = null;
  let lastError = '';         // last non-network failure, shown as "সিঙ্ক ব্যর্থ"
  let netDown = !navigator.onLine;
  let pendingRestore = null;  // validated backup waiting for confirmation

  const configured = () => Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  const isActive = () => Boolean(client && user);
  const syncState = () => Core.emptySync(S.app.sync);
  const hasOwner = () => Boolean(S.app.sync && S.app.sync.ownerId);

  /* ---------- status ---------- */
  function computeStatus() {
    const sy = syncState();
    const pending = Core.countPending({ people: S.people, txns: S.txns, sync: sy });
    const conflicts = sy.conflicts.length;
    const base = { pending, conflicts, lastSyncedAt: sy.lastSyncedAt };
    if (!configured()) return { ...base, state: 'local', label: 'শুধু এই ডিভাইসে', detail: 'ক্লাউড এখনও কনফিগার করা হয়নি' };
    if (lastError && !client) return { ...base, state: 'failed', label: 'সিঙ্ক ব্যর্থ', detail: lastError };
    if (!client) return { ...base, state: 'offline', label: 'অফলাইন', detail: 'ক্লাউড লাইব্রেরি লোড হয়নি' };
    if (!user) return { ...base, state: 'local', label: 'শুধু এই ডিভাইসে', detail: 'সাইন ইন করলে তথ্য ক্লাউডে সিঙ্ক হবে' };
    if (running) return { ...base, state: 'syncing', label: 'সিঙ্ক হচ্ছে', detail: '' };
    if (netDown) return { ...base, state: 'offline', label: 'অফলাইন', detail: pending ? `${toBn(pending)}টি পরিবর্তন অপেক্ষায় আছে` : 'ইন্টারনেট সংযোগ নেই' };
    if (lastError || conflicts) {
      return { ...base, state: 'failed', label: 'সিঙ্ক ব্যর্থ',
        detail: lastError || `${toBn(conflicts)}টি সংঘাত আছে — সেটিংস থেকে সমাধান করুন` };
    }
    return { ...base, state: 'synced', label: 'সিঙ্ক হয়েছে',
      detail: sy.lastSyncedAt ? `সর্বশেষ: ${fmtDT(sy.lastSyncedAt)}` : (pending ? `${toBn(pending)}টি পরিবর্তন অপেক্ষায়` : '') };
  }
  function refreshUI() {
    const s = computeStatus();
    document.querySelectorAll('[data-sync-pill]').forEach(el => {
      el.className = 'pill ' + s.state;
      el.title = s.detail || '';
      el.innerHTML = `<i class="dot"></i>${s.label}`;
    });
  }
  function statusPill() {
    const s = computeStatus();
    return `<span class="pill ${s.state}" data-sync-pill title="${esc(s.detail || '')}"><i class="dot"></i>${s.label}</span>`;
  }

  function friendly(err) {
    const m = String((err && err.message) || err || '');
    if (/Invalid login credentials/i.test(m)) return 'ইমেইল বা পাসওয়ার্ড ভুল।';
    if (/Email not confirmed/i.test(m)) return 'ইমেইল এখনও নিশ্চিত হয়নি। ইনবক্সের লিংকে ক্লিক করুন।';
    if (/already registered|already exists/i.test(m)) return 'এই ইমেইলে আগে থেকে অ্যাকাউন্ট আছে। সাইন ইন করুন।';
    if (/rate limit|too many/i.test(m)) return 'অনেকবার চেষ্টা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।';
    if (/LEDGER/i.test(m)) return 'ক্লাউডের হিসাব এই পরিবর্তনের সাথে মিলছে না।';
    if (/AUTH_REQUIRED|jwt expired|JWT/i.test(m)) return 'সেশন শেষ হয়েছে। আবার সাইন ইন করুন।';
    if (Core.isNetworkError(err, navigator)) return 'ইন্টারনেট সংযোগ নেই।';
    return 'সমস্যা হয়েছে: ' + m;
  }

  /* ---------- sync ---------- */
  function kick(delay = 1200) {
    clearTimeout(debounce);
    debounce = setTimeout(syncNow, delay);
  }
  function changed() {
    if (isActive()) kick(1200);
    else refreshUI();
  }

  async function syncNow() {
    if (!isActive() || netDown) { refreshUI(); return; }
    if (running) { rerun = true; return; }
    running = true;
    lastError = '';
    refreshUI();
    try {
      const env = {
        getState: () => ({ people: S.people, txns: S.txns, sync: syncState() }),
        commit: async (st) => {
          S.people = st.people;
          S.txns = st.txns;
          S.app.sync = st.sync;
          await persistAll();
        },
        push: async (changes) => {
          const { data, error } = await client.rpc('sync_push', { p_changes: changes });
          if (error) throw error;
          return data;
        },
        pull: async (since) => {
          const { data, error } = await client.rpc('sync_pull', { p_since: since });
          if (error) throw error;
          return data;
        },
      };
      await Core.runSync(env);
      netDown = false;
    } catch (err) {
      if (Core.isNetworkError(err, navigator)) netDown = true;
      else lastError = friendly(err);
    } finally {
      running = false;
    }
    refreshUI();
    // refresh an open Settings/Backup screen so conflicts and timestamps show up (never while a sheet is open)
    if (!$('#sheet').classList.contains('open') && !S.ui.personId && (S.ui.tab === 'settings' || S.ui.tab === 'backup')) render();
    if (rerun) { rerun = false; kick(0); }
  }

  async function persistSync(patch) {
    S.app.sync = { ...syncState(), ...patch };
    await saveApp({ sync: S.app.sync });
  }

  /* first run on this device: make sure every local record carries sync fields */
  async function migrateLocal() {
    const before = S.people.length + S.txns.length;
    const p = Core.ensureSyncFields(S.people);
    const t = Core.ensureSyncFields(S.txns);
    const changed = p.some((x, i) => x !== S.people[i]) || t.some((x, i) => x !== S.txns[i]);
    S.people = p;
    S.txns = t;
    S.app.sync = syncState();
    if (changed || before === 0) await persistAll();
  }

  /* ---------- auth ---------- */
  async function onSignedIn() {
    const sy = syncState();
    const hasLocal = S.people.some(p => !p.demo) || S.txns.some(t => !t.demo);
    if (sy.ownerId && sy.ownerId !== user.id) {
      if (hasLocal) {
        // never upload one account's local data into another account
        lastError = 'এই ডিভাইসে অন্য অ্যাকাউন্টের তথ্য আছে। আগে ব্যাকআপ নিয়ে সব তথ্য মুছুন, তারপর সাইন ইন করুন।';
        toast(lastError, true);
        await client.auth.signOut();
        return;
      }
      await persistSync({ ownerId: user.id, cursor: null, tombs: [], conflicts: [], lastSyncedAt: null });
    } else if (!sy.ownerId) {
      await persistSync({ ownerId: user.id });
    }
    kick(0);
  }

  function onAuthChanged(event, session) {
    if (event === 'INITIAL_SESSION') return;
    user = session ? session.user : null;
    if (event === 'SIGNED_IN') onSignedIn();
    if (event === 'SIGNED_OUT') { clearTimeout(debounce); user = null; }
    if (event === 'PASSWORD_RECOVERY') openNewPasswordSheet();
    refreshUI();
    render();
  }

  async function signOut() {
    const pending = Core.countPending({ people: S.people, txns: S.txns, sync: syncState() });
    if (pending && !confirm(`${toBn(pending)}টি পরিবর্তন এখনও ক্লাউডে যায়নি। সাইন আউট করলে এগুলো এই ডিভাইসে থেকে যাবে এবং পরে সিঙ্ক হবে। চালিয়ে যাবেন?`)) return;
    await client.auth.signOut();
    toast('সাইন আউট হয়েছে। তথ্য এই ডিভাইসে আছে।');
  }

  function openAuthSheet(mode = 'signin') {
    const isUp = mode === 'signup';
    const isReset = mode === 'reset';
    const title = isReset ? 'পাসওয়ার্ড রিসেট' : isUp ? 'নতুন অ্যাকাউন্ট' : 'সাইন ইন';
    const btn = isReset ? 'রিসেট লিংক পাঠান' : isUp ? 'অ্যাকাউন্ট খুলুন' : 'সাইন ইন করুন';
    openSheet(title, `
      <form data-form="cloudAuth">
        <input type="hidden" name="mode" value="${mode}">
        ${field('ইমেইল', '<input type="email" name="email" autocomplete="email" required>')}
        ${isReset ? '' : field('পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)', `<input type="password" name="password" autocomplete="${isUp ? 'new-password' : 'current-password'}">`)}
        <div class="err" hidden></div>
        <button class="btn block" type="submit">${btn}</button>
      </form>
      <div class="stack" style="margin-top:12px">
        ${mode !== 'signin' ? '<button class="btn ghost block" data-act="cloudAuthMode" data-mode="signin">আগে থেকে অ্যাকাউন্ট আছে</button>' : ''}
        ${mode !== 'signup' ? '<button class="btn ghost block" data-act="cloudAuthMode" data-mode="signup">নতুন অ্যাকাউন্ট খুলুন</button>' : ''}
        ${mode !== 'reset' ? '<button class="btn ghost block" data-act="cloudAuthMode" data-mode="reset">পাসওয়ার্ড ভুলে গেছি</button>' : ''}
      </div>
      <p class="muted">ইমেইল ও পাসওয়ার্ড শুধু Supabase Auth-এ থাকে। এই অ্যাপ সেগুলো সংরক্ষণ করে না; ব্রাউজারে শুধু সেশন টোকেন থাকে।</p>`);
  }

  async function submitAuth(f) {
    const fd = new FormData(f);
    const mode = String(fd.get('mode') || 'signin');
    const email = String(fd.get('email') || '').trim();
    const password = String(fd.get('password') || '');
    const box = f.querySelector('.err');
    const fail = msg => { box.textContent = msg; box.hidden = false; };
    if (!client) return fail('ক্লাউড এখন চালু নেই। ইন্টারনেট সংযোগ ও কনফিগারেশন দেখুন।');
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail('সঠিক ইমেইল লিখুন।');
    if (mode !== 'reset' && password.length < MIN_PASSWORD) return fail('পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে।');
    const redirectTo = location.href.split('#')[0].split('?')[0];

    if (mode === 'reset') {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) return fail(friendly(error));
      closeSheet();
      return toast('রিসেট লিংক ইমেইলে পাঠানো হয়েছে');
    }
    if (mode === 'signup') {
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
      if (error) return fail(friendly(error));
      closeSheet();
      return toast(data.session ? 'অ্যাকাউন্ট খোলা হয়েছে' : 'নিশ্চিতকরণ লিংক ইমেইলে পাঠানো হয়েছে। লিংকে ক্লিক করে সাইন ইন করুন।');
    }
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) return fail(friendly(error));
    closeSheet();
    toast('সাইন ইন হয়েছে');
  }

  function openNewPasswordSheet() {
    openSheet('নতুন পাসওয়ার্ড', `
      <form data-form="cloudNewPassword">
        ${field('নতুন পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)', '<input type="password" name="password" autocomplete="new-password">')}
        <div class="err" hidden></div>
        <button class="btn block" type="submit">পাসওয়ার্ড সংরক্ষণ করুন</button>
      </form>`);
  }
  async function submitNewPassword(f) {
    const password = String(new FormData(f).get('password') || '');
    const box = f.querySelector('.err');
    if (password.length < MIN_PASSWORD) { box.textContent = 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে।'; box.hidden = false; return; }
    const { error } = await client.auth.updateUser({ password });
    if (error) { box.textContent = friendly(error); box.hidden = false; return; }
    closeSheet();
    toast('নতুন পাসওয়ার্ড সংরক্ষিত হয়েছে');
  }

  /* ---------- conflicts ---------- */
  async function resolve(key, choice) {
    const st = Core.resolveConflict({ people: S.people, txns: S.txns, sync: syncState() }, key, choice);
    S.people = st.people;
    S.txns = st.txns;
    S.app.sync = st.sync;
    await persistAll();
    toast(choice === 'local' ? 'এই ডিভাইসের সংস্করণ রাখা হয়েছে' : 'ক্লাউডের সংস্করণ রাখা হয়েছে');
    render();
    refreshUI();
    if (isActive()) kick(0);
  }

  /* ---------- cloud backup ---------- */
  async function createBackup() {
    if (!isActive()) return toast('ক্লাউড ব্যাকআপের জন্য আগে সাইন ইন করুন', true);
    if (netDown) return toast('ইন্টারনেট সংযোগ নেই। সংযোগ ফিরলে আবার চেষ্টা করুন।', true);
    if (isDemoActive()) return toast('ডেমো ডেটার ব্যাকআপ হয় না। সেটিংস থেকে ডেমো মুছুন।', true);
    const payload = Core.buildPayload(S.people, S.txns, new Date().toISOString());
    const checksum = await Core.checksumOf(payload);
    const { data, error } = await client.from('cloud_backups')
      .insert({ record_count: payload.people.length + payload.txns.length, checksum, payload })
      .select('id')
      .single();
    if (error) throw error;
    // verify what the server stored before claiming success
    const { data: back, error: e2 } = await client.from('cloud_backups').select('payload').eq('id', data.id).single();
    if (e2) throw e2;
    if ((await Core.checksumOf(back.payload)) !== checksum) throw new Error('ব্যাকআপ যাচাই ব্যর্থ হয়েছে');
    await persistSync({ lastCloudBackupAt: new Date().toISOString() });
    toast('ক্লাউড ব্যাকআপ তৈরি ও যাচাই হয়েছে');
    refreshUI();
    loadBackupList();
  }

  async function loadBackupList() {
    const box = document.getElementById('cloud-backups');
    if (!box || !isActive()) return;
    if (netDown) { box.innerHTML = '<p class="muted">অফলাইন: ব্যাকআপের তালিকা দেখতে সংযোগ লাগবে।</p>'; return; }
    try {
      const { data, error } = await client.from('cloud_backups')
        .select('id, created_at, record_count').order('created_at', { ascending: false }).limit(20);
      if (error) throw error;
      box.innerHTML = data.length
        ? data.map(b => `<div class="row">
            <div class="main"><div class="name">${fmtDT(b.created_at)}</div><div class="muted">${toBn(b.record_count)} টি রেকর্ড</div></div>
            <button class="btn ghost" data-act="cloudRestorePick" data-id="${b.id}">পুনরুদ্ধার</button>
            <button class="btn ghost" data-act="cloudDeleteBackup" data-id="${b.id}">মুছুন</button></div>`).join('')
        : '<p class="muted">এখনও কোনো ক্লাউড ব্যাকআপ নেই।</p>';
    } catch (e) {
      box.innerHTML = `<div class="err">ব্যাকআপের তালিকা আনা যায়নি: ${esc(friendly(e))}</div>`;
    }
  }

  async function restorePick(id) {
    if (!isActive() || netDown) return toast('পুনরুদ্ধারের জন্য অনলাইন ও সাইন ইন প্রয়োজন', true);
    const { data, error } = await client.from('cloud_backups').select('payload, checksum').eq('id', id).single();
    if (error) throw error;
    if ((await Core.checksumOf(data.payload)) !== data.checksum) {
      return openSheet('ব্যাকআপ যাচাই ব্যর্থ', '<div class="err-box">এই ব্যাকআপের তথ্য মিলছে না। এটি ব্যবহার করা হবে না।</div>');
    }
    const v = validateBackup(data.payload);
    if (v.errs.length) {
      return openSheet('ব্যাকআপ যাচাই ব্যর্থ', `<div class="err-box">${v.errs.map(esc).join('<br>')}</div>`);
    }
    pendingRestore = v;
    openSheet('ক্লাউড থেকে পুনরুদ্ধার', `
      <p>ব্যাকআপে আছে: <b>${toBn(v.people.length)}</b> জন ব্যক্তি, <b>${toBn(v.txns.length)}</b> টি লেনদেন।</p>
      <div class="err-box">এতে ক্লাউডের বর্তমান সব তথ্য বদলে যাবে, এবং যেসব অসংরক্ষিত পরিবর্তন এখনও সিঙ্ক হয়নি সেগুলো হারিয়ে যাবে। নিশ্চিত হলে নিচে বাটনে চাপুন।</div>
      <div class="stack" style="margin-top:12px">
        <button class="btn danger block" data-act="cloudRestoreConfirm">হ্যাঁ, ব্যাকআপ দিয়ে বদলে দিন</button>
        <button class="btn ghost block" data-act="close">বাতিল করুন</button>
      </div>`);
  }

  async function restoreConfirm() {
    if (!pendingRestore) return;
    const v = pendingRestore;
    pendingRestore = null;
    await replaceEverywhere(v.people, v.txns);
  }

  /* Used by restore-from-cloud and by JSON import while signed in. Requires the server. */
  async function replaceEverywhere(people, txns) {
    if (!isActive() || netDown) {
      throw new Error('ক্লাউডের তথ্য বদলাতে অনলাইন ও সাইন ইন প্রয়োজন। অফলাইনে শুধু মার্জ করা যাবে।');
    }
    const { data, error } = await client.rpc('sync_replace_all', {
      p_people: people.map(Core.toCloudPerson),
      p_txns: txns.map(Core.toCloudTxn),
    });
    if (error) throw error;
    const next = Core.stateAfterReplace(people, txns, data, data.server_time, syncState());
    S.people = next.people;
    S.txns = next.txns;
    S.app.sync = next.sync;
    S.ui.pending = null;
    S.ui.importErr = [];
    await persistAll();
    closeSheet();
    toast('ক্লাউড ও এই ডিভাইস এখন একই তথ্য দেখাচ্ছে');
    render();
    refreshUI();
  }

  async function deleteBackup(id) {
    if (!confirm('এই ক্লাউড ব্যাকআপটি মুছবেন? এটি ফেরত আনা যাবে না।')) return;
    const { error } = await client.from('cloud_backups').delete().eq('id', id);
    if (error) throw error;
    toast('ব্যাকআপ মুছে ফেলা হয়েছে');
    loadBackupList();
  }

  /* ---------- screens ---------- */
  function conflictsHTML(list) {
    if (!list.length) return '';
    return `<h2>সংঘাত (${toBn(list.length)})</h2>
      <p class="muted">একই তথ্য দুই জায়গায় বদলেছে। কোন সংস্করণ রাখবেন বেছে নিন। কিছুই নিজে থেকে মুছবে না।</p>` +
      list.map(c => {
        const label = c.kind === 'person' ? 'ব্যক্তি' : 'লেনদেন';
        const reason = c.reason === 'rejected'
          ? `ক্লাউড এটি নেয়নি: ${esc(c.message || '')}`
          : c.op === 'delete'
            ? 'এই ডিভাইসে মুছেছেন, কিন্তু অন্য ডিভাইসে বদলেছে'
            : 'অন্য ডিভাইসে আগে বদলেছে';
        return `<div class="preview">
          <div><b>${label}</b> · ${reason}</div>
          <div class="row-actions">
            <button class="btn ghost" data-act="cloudResolve" data-key="${esc(c.key)}" data-choice="local">আমার সংস্করণ রাখুন</button>
            <button class="btn ghost" data-act="cloudResolve" data-key="${esc(c.key)}" data-choice="server">ক্লাউডের সংস্করণ রাখুন</button>
          </div></div>`;
      }).join('');
  }

  function settingsHTML() {
    const s = computeStatus();
    const sy = syncState();
    const head = '<h2>ক্লাউড অ্যাকাউন্ট ও সিঙ্ক</h2>';
    if (!configured()) {
      return head + `<p class="muted">ক্লাউড সেটআপ বাকি। <code>config.js</code>-এ Supabase Project URL ও public anon key বসান, অথবা Vercel-এর Environment Variables-এ <code>SUPABASE_URL</code> ও <code>SUPABASE_ANON_KEY</code> দিন। এখন সব তথ্য শুধু এই ডিভাইসে আছে।</p>`;
    }
    if (!user) {
      return head + `<p class="muted">সাইন ইন করলে তথ্য ক্লাউডে সিঙ্ক হবে এবং অন্য ডিভাইসে পাওয়া যাবে। অফলাইনে কাজ চলবে; সংযোগ ফিরলে নিজে থেকে সিঙ্ক হবে।</p>
        <button class="btn block" data-act="cloudAuth">সাইন ইন / নতুন অ্যাকাউন্ট</button>`;
    }
    return head + `
      <div class="kv"><span>অ্যাকাউন্ট</span><b>${esc(user.email || '')}</b></div>
      <div class="kv"><span>সিঙ্ক অবস্থা</span><b>${statusPill()}</b></div>
      <div class="kv"><span>অপেক্ষায় পরিবর্তন</span><b>${toBn(s.pending)}</b></div>
      <div class="kv"><span>সর্বশেষ সফল সিঙ্ক</span><b>${sy.lastSyncedAt ? fmtDT(sy.lastSyncedAt) : 'এখনও হয়নি'}</b></div>
      ${s.detail ? `<p class="muted">${esc(s.detail)}</p>` : ''}
      ${conflictsHTML(sy.conflicts)}
      <div class="stack" style="margin-top:12px">
        <button class="btn block" data-act="cloudSync">এখনই সিঙ্ক করুন</button>
        <button class="btn ghost block" data-act="cloudSignOut">সাইন আউট</button>
      </div>`;
  }

  function backupHTML() {
    const active = isActive();
    if (active) setTimeout(loadBackupList, 0);
    return `<h2>ক্লাউড ব্যাকআপ</h2>
      <p class="muted">${active
        ? 'ব্যাকআপ Supabase-এ সংরক্ষিত হয় এবং তৈরির পর যাচাই করা হয়। সর্বশেষ ২০টি রাখা হয়।'
        : (configured() ? 'ক্লাউড ব্যাকআপ চালাতে সেটিংস থেকে সাইন ইন করুন।' : 'ক্লাউড কনফিগার হলে এখানে ব্যাকআপ পাওয়া যাবে।')}</p>
      <button class="btn block" data-act="cloudBackup" ${active && !netDown ? '' : 'disabled'}>ক্লাউডে ব্যাকআপ নিন</button>
      <div id="cloud-backups"><p class="muted">${active ? 'তালিকা লোড হচ্ছে…' : ''}</p></div>`;
  }

  /* ---------- acts & forms (merged into app.js registries) ---------- */
  Object.assign(acts, {
    cloudAuth: () => openAuthSheet('signin'),
    cloudAuthMode: el => openAuthSheet(el.dataset.mode),
    cloudSync: () => { netDown = !navigator.onLine; kick(0); toast('সিঙ্ক শুরু হয়েছে'); },
    cloudSignOut: () => signOut(),
    cloudBackup: () => createBackup(),
    cloudRestorePick: el => restorePick(el.dataset.id),
    cloudRestoreConfirm: () => restoreConfirm(),
    cloudDeleteBackup: el => deleteBackup(el.dataset.id),
    cloudResolve: el => resolve(el.dataset.key, el.dataset.choice),
  });
  Object.assign(forms, {
    cloudAuth: submitAuth,
    cloudNewPassword: submitNewPassword,
  });

  /* ---------- start ---------- */
  async function start() {
    await migrateLocal();
    window.addEventListener('online', () => { netDown = false; kick(300); refreshUI(); });
    window.addEventListener('offline', () => { netDown = true; refreshUI(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && isActive()) kick(500); });
    setInterval(() => { if (isActive() && !document.hidden) kick(0); }, 60000);

    if (configured()) {
      try {
        Core.assertPublicKey(cfg.SUPABASE_ANON_KEY);
        if (window.supabase && typeof window.supabase.createClient === 'function') {
          client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
          });
          client.auth.onAuthStateChange(onAuthChanged);
          const { data } = await client.auth.getSession();
          user = data.session ? data.session.user : null;
          if (user) onSignedIn();
        }
      } catch (err) {
        lastError = err.message || String(err);
      }
    }
    refreshUI();
    render();
  }

  window.Cloud = {
    start,
    changed,
    isActive,
    hasOwner,
    replaceEverywhere,
  };
  window.CloudUI = {
    statusPill,
    settingsHTML,
    backupHTML,
  };

  // app.js announces when local data is loaded; start immediately if it already is
  if (typeof S !== 'undefined' && S.loaded) start();
  else window.addEventListener('hisab:loaded', start, { once: true });
})();
