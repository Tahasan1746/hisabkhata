'use strict';
/* Smoke tests for the browser code paths touched by the cloud work.
 * Loads the real app.js, sync-core.js and cloud.js into a sandbox with minimal DOM and IndexedDB stubs.
 * This proves the screens render, the save/reset/import paths run, and local-only mode works. It does not
 * replace a real browser test (see the manual checklist in README.md). */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function fakeElement() {
  return {
    innerHTML: '', textContent: '', className: '', title: '', value: '', hidden: false, dataset: {}, files: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
}

class FakeFormData {                       // stands in for the browser's FormData(form)
  constructor(form) { this.m = new Map(form && form.fields ? form.fields : []); }
  get(k) { return this.m.has(k) ? this.m.get(k) : null; }
}

function makeSandbox(config) {
  const els = new Map();
  const $el = sel => { if (!els.has(sel)) els.set(sel, fakeElement()); return els.get(sel); };
  const sandbox = {
    window: null,
    HISAB_CONFIG: config,
    document: {
      documentElement: { dataset: {} }, body: { appendChild() {} }, hidden: false, readyState: 'complete',
      querySelector: $el, querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener() {}, createElement: () => ({ click() {}, remove() {} }),
    },
    navigator: { onLine: true },
    location: { href: 'http://localhost/hisabkhata/' },
    indexedDB: { open: () => ({}) },              // boot waits on this forever; tests drive state directly
    confirm: () => true,
    alert: () => {},
    FormData: FakeFormData,
    crypto: globalThis.crypto, TextEncoder, atob, Event, URL,
    setTimeout, clearTimeout, clearInterval, setImmediate, Intl, Date, JSON, Math, Map, Set, Promise,
    // the background sync timer must not keep the test process alive
    setInterval: (...a) => { const t = setInterval(...a); if (t && t.unref) t.unref(); return t; },
    console,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  sandbox.scrollTo = () => {};
  vm.createContext(sandbox);
  return sandbox;
}

/* an in-memory stand-in for the IndexedDB database object used by dbRun */
function fakeDb() {
  return {
    transaction() {
      const t = { oncomplete: null, onerror: null, onabort: null, objectStore: () => ({ put() {}, clear() {}, delete() {}, getAll() {} }) };
      setImmediate(() => { if (t.oncomplete) t.oncomplete(); });
      return t;
    },
  };
}

function boot(config = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' }) {
  const ctx = makeSandbox(config);
  vm.runInContext(read('sync-core.js'), ctx, { filename: 'sync-core.js' });
  vm.runInContext(read('app.js'), ctx, { filename: 'app.js' });
  ctx.__db = fakeDb();
  vm.runInContext('db = __db', ctx);
  vm.runInContext('S.loaded = false', ctx);          // keep cloud.js from auto-starting until a test asks
  vm.runInContext(read('cloud.js'), ctx, { filename: 'cloud.js' });
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
const seed = (ctx, data) => { ctx.__seed = data; run(ctx, 'S.people = __seed.people; S.txns = __seed.txns; S.loaded = true;'); };

const P = (id, name, extra = {}) => ({ id, name, phone: '01700000001', notes: '', archived: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra });
const T = (id, personId, type, amount, date, extra = {}) => ({ id, personId, type, amount, date, dueDate: null, category: 'ব্যক্তিগত', note: '', voided: false, audit: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra });

test('dashboard renders with the sync pill in local-only mode', () => {
  const ctx = boot();
  seed(ctx, { people: [P('p1', 'রহিম')], txns: [T('t1', 'p1', 'lent', 500000, '2026-10-01', { dueDate: '2026-10-20' })] });
  const html = run(ctx, 'viewDash()');
  assert.match(html, /শুধু এই ডিভাইসে/);
  assert.match(html, /৳/);
  assert.match(html, /রহিম/);
});

test('settings explains how to configure the cloud when no config is present', () => {
  const ctx = boot();
  seed(ctx, { people: [], txns: [] });
  const html = run(ctx, 'viewSettings()');
  assert.match(html, /ক্লাউড সেটআপ বাকি/);
  assert.match(html, /SUPABASE_ANON_KEY/);
});

test('settings offers sign-in once a project is configured (no session yet)', () => {
  const ctx = boot({ SUPABASE_URL: 'https://abcdefgh.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_TESTVALUE123' });
  seed(ctx, { people: [], txns: [] });
  const html = run(ctx, 'viewSettings()');
  assert.match(html, /data-act="cloudAuth"/);
  assert.doesNotMatch(html, /সেটআপ বাকি/);
});

test('the backup screen shows the cloud section disabled until signed in', () => {
  const ctx = boot();
  seed(ctx, { people: [], txns: [] });
  const html = run(ctx, 'viewBackup()');
  assert.match(html, /ক্লাউড ব্যাকআপ/);
  assert.match(html, /data-act="cloudBackup" disabled/);
});

test('a saved transaction is marked dirty with a revision, ready for sync', async () => {
  const ctx = boot();
  seed(ctx, { people: [P('p1', 'রহিম')], txns: [] });
  ctx.__form = { fields: [['id', ''], ['personId', 'p1'], ['type', 'lent'], ['amount', '৫০০০'], ['date', '2026-10-01'],
    ['dueDate', '2026-10-20'], ['category', 'ব্যবসা'], ['note', 'পরীক্ষা']], querySelector: () => null };
  run(ctx, 'saveTxn(__form)');
  await new Promise(r => setImmediate(r));
  const t = run(ctx, 'S.txns[0]');
  assert.equal(run(ctx, 'S.txns.length'), 1);
  assert.equal(t.amount, 500000, 'Bangla digits are converted and the amount is stored in paisa');
  assert.equal(t.dirty, true);
  assert.equal(t.rev, 1);
  assert.equal(t.sv, undefined, 'a new record has no server version yet');
});

test('an over-repayment is refused locally with a clear message and nothing is saved', async () => {
  const ctx = boot();
  seed(ctx, { people: [P('p1', 'রহিম')], txns: [T('t1', 'p1', 'lent', 500000, '2026-10-01')] });
  let toastMsg = '';
  ctx.__form = { fields: [['id', ''], ['personId', 'p1'], ['type', 'received'], ['amount', '6000'], ['date', '2026-10-03'],
    ['category', 'ব্যক্তিগত'], ['note', '']], querySelector: () => null };
  run(ctx, 'saveTxn(__form)');
  await new Promise(r => setImmediate(r));
  assert.equal(run(ctx, 'S.txns.length'), 1, 'no repayment was stored');
  toastMsg = run(ctx, "document.querySelector('#toast').textContent");
  assert.match(toastMsg, /বেশি গ্রহণ করা যাবে না/);
});

test('local records from before sync get sync fields when the cloud layer starts (no network needed)', async () => {
  const ctx = boot();
  seed(ctx, { people: [P('p1', 'রহিম')], txns: [T('t1', 'p1', 'lent', 500000, '2026-10-01')] });
  await run(ctx, 'Cloud.start()');
  assert.equal(run(ctx, 'S.people[0].sv'), 0);
  assert.equal(run(ctx, 'S.people[0].dirty'), true);
  assert.equal(run(ctx, 'S.txns[0].dirty'), true);
  assert.equal(run(ctx, 'Cloud.isActive()'), false);
});

test('reset creates tombstones only for records the cloud already knows about', async () => {
  const ctx = boot();
  seed(ctx, {
    people: [P('p1', 'রহিম', { sv: 2, dirty: false }), P('p2', 'ডেমো', { demo: true, sv: 0 }), P('p3', 'নতুন', { sv: 0, dirty: true })],
    txns: [T('t1', 'p1', 'lent', 500000, '2026-10-01', { sv: 3, dirty: false })],
  });
  await run(ctx, 'resetAll()');
  const tombs = run(ctx, 'S.app.sync.tombs');
  // values come from the sandbox realm; normalise before comparing
  assert.deepEqual(JSON.parse(JSON.stringify(tombs.map(t => t.id))).sort(), ['p1', 't1']);
  assert.equal(run(ctx, 'S.people.length'), 0);
});

test('JSON validation refuses a file containing a password field and accepts a clean export', () => {
  const ctx = boot();
  const bad = run(ctx, "validateBackup({app:'hisabkhata', version:1, people:[], txns:[], password:'x'})");
  assert.ok(bad.errs.length && /গোপন/.test(bad.errs[0]));
  const good = run(ctx, "validateBackup({app:'hisabkhata', version:1, people:[{id:'p1', name:'রহিম', phone:'', notes:'', archived:false}], txns:[]})");
  assert.equal(good.errs.length, 0);
  assert.equal(good.people.length, 1);
});

test('starting the app without the cloud library still works (offline-only)', async () => {
  const ctx = boot({ SUPABASE_URL: 'https://abcdefgh.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_TESTVALUE123' });
  seed(ctx, { people: [P('p1', 'রহিম')], txns: [] });
  await run(ctx, 'Cloud.start()');
  const pill = run(ctx, 'CloudUI.statusPill()');
  assert.match(pill, /অফলাইন/, 'the library is missing in this sandbox, so the status says offline');
  assert.equal(run(ctx, 'Cloud.isActive()'), false);
});

test('a service-role key in the config is refused by the browser layer', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.sig';
  const ctx = boot({ SUPABASE_URL: 'https://abcdefgh.supabase.co', SUPABASE_ANON_KEY: jwt });
  seed(ctx, { people: [], txns: [] });
  await run(ctx, 'Cloud.start()');
  const pill = run(ctx, 'CloudUI.statusPill()');
  assert.match(pill, /সিঙ্ক ব্যর্থ/);
  assert.match(pill, /সার্ভিস-রোল/, 'the reason is shown in the status detail');
  assert.equal(run(ctx, 'Cloud.isActive()'), false, 'no client was created with a secret key');
});
