'use strict';
/* Run: npm test. Covers the WhatsApp Click-to-Chat feature without any network or WhatsApp account. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../whatsapp-core.js');

/* ---------------- number validation ---------------- */
test('valid Bangladeshi numbers are accepted in every common form and stored as +880…', () => {
  for (const input of ['01712345678', '+8801712345678', '8801712345678', ' 017-1234-5678 ', '(+880) 17 1234 5678', '০১৭১২৩৪৫৬৭৮']) {
    const r = Core.normalizePhone(input);
    assert.equal(r.ok, true, input);
    assert.equal(r.e164, '+8801712345678', input);
    assert.equal(r.digits, '8801712345678', input);
    assert.equal(r.country, 'BD');
  }
});

test('Bangladeshi mobile prefixes must be 013 to 019', () => {
  assert.equal(Core.normalizePhone('01312345678').ok, true);
  assert.equal(Core.normalizePhone('01912345678').ok, true);
  const bad = Core.normalizePhone('01212345678');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /013 থেকে 019/);
});

test('wrong lengths get a specific, useful message', () => {
  const short = Core.normalizePhone('0171234567');
  assert.equal(short.ok, false);
  assert.match(short.error, /১১ সংখ্যার/);
  const long = Core.normalizePhone('017123456789');
  assert.equal(long.ok, false);
  assert.match(long.error, /১১ সংখ্যার/);
  const shortIntl = Core.normalizePhone('+88017123');
  assert.equal(shortIntl.ok, false);
});

test('empty input, letters, and misplaced plus signs are refused with a clear message', () => {
  assert.match(Core.normalizePhone('').error, /লিখুন/);
  assert.match(Core.normalizePhone('   ').error, /লিখুন/);
  assert.match(Core.normalizePhone('0171abc5678').error, /শুধু সংখ্যা/);
  assert.match(Core.normalizePhone('0171+2345678').error, /\+ চিহ্ন/);
  assert.match(Core.normalizePhone('++8801712345678').error, /\+ চিহ্ন/);
  assert.match(Core.normalizePhone('5550123').error, /বাংলাদেশের নম্বর/);
});

test('other countries in international format are accepted (8–15 digits)', () => {
  const ok = Core.normalizePhone('+1 (415) 555-0123');
  assert.equal(ok.ok, true);
  assert.equal(ok.e164, '+14155550123');
  assert.equal(ok.country, 'other');
  assert.equal(Core.normalizePhone('+1').ok, false);
});

/* ---------------- Click-to-Chat link ---------------- */
test('the link uses wa.me with digits only and an encoded text parameter', () => {
  const url = Core.waLink('8801712345678', 'হ্যালো & স্বাগতম? # 100%');
  assert.match(url, /^https:\/\/wa\.me\/8801712345678\?text=/);
  assert.equal(url.includes(' '), false, 'no raw spaces');
  assert.equal(decodeURIComponent(url.split('?text=')[1]), 'হ্যালো & স্বাগতম? # 100%');
});

test('text containing &, #, ?, + and newlines survives the round trip exactly', () => {
  const text = 'a+b & c=d #e ?f\nনতুন লাইন 📅';
  const url = Core.waLink('8801712345678', text);
  assert.equal(decodeURIComponent(url.split('?text=')[1]), text);
});

test('a bad number cannot produce a link', () => {
  assert.throws(() => Core.waLink('abc', 'x'), /invalid/);
});

/* ---------------- Bengali messages from record data ---------------- */
test('an overdue loan message includes the person, the amounts, the due date, the status and the payment state', () => {
  const msg = Core.buildMessage({
    kind: 'reminder', name: 'রহিম', loanType: 'lent', amount: 500000, repaid: 200000, remaining: 300000,
    dueDate: '2026-10-05', status: 'overdue', days: 5,
  });
  assert.match(msg, /^আসসালামু আলাইকুম রহিম,/);
  assert.match(msg, /৳৩,০০০ পাওনা/);
  assert.match(msg, /৫ দিন আগে পার হয়ে গেছে/);
  assert.match(msg, /৫ অক্টোবর/);
  assert.match(msg, /আংশিক পরিশোধ/);
  assert.match(msg, /ধার: ৳৫,০০০ · পরিশোধ: ৳২,০০০ · বাকি: ৳৩,০০০/);
});

test('an upcoming borrowed loan says what I owe and how many days remain', () => {
  const msg = Core.buildMessage({
    kind: 'reminder', name: 'করিম', loanType: 'borrowed', amount: 400000, repaid: 0, remaining: 400000,
    dueDate: '2026-10-13', status: 'upcoming', days: 3,
  });
  assert.match(msg, /আপনার কাছে আমার ৳৪,০০০ দেনা বাকি আছে/);
  assert.match(msg, /আর ৩ দিন বাকি/);
  assert.match(msg, /এখনও পরিশোধ হয়নি/);
});

test('a repayment message names the direction and shows the remaining balance', () => {
  const received = Core.buildMessage({ kind: 'repay', name: 'রহিম', type: 'received', amount: 200000, date: '2026-10-03', balance: 300000 });
  assert.match(received, /আমি আপনার কাছ থেকে ৳২,০০০ পেয়েছি/);
  assert.match(received, /এখনও বাকি আছে: ৳৩,০০০/);
  const paid = Core.buildMessage({ kind: 'repay', name: 'করিম', type: 'paid', amount: 150000, date: '2026-10-04', balance: 0 });
  assert.match(paid, /আমি আপনাকে ৳১,৫০০ পরিশোধ করেছি/);
  assert.match(paid, /সম্পূর্ণ পরিশোধিত/);
});

test('the message that opens in WhatsApp is exactly the message that was built (round trip)', () => {
  const msg = Core.buildMessage({
    kind: 'reminder', name: 'রহিম & সন্তান?', loanType: 'lent', amount: 123450, repaid: 0, remaining: 123450,
    dueDate: '2026-10-20', status: 'later', days: 0,
  });
  const url = Core.waLink('8801712345678', msg);
  assert.equal(decodeURIComponent(url.split('?text=')[1]), msg);
});

test('fractional taka keep two decimals in messages', () => {
  assert.equal(Core.fmtTaka(123450), '৳১,২৩৪.৫০');
  assert.equal(Core.fmtTaka(100), '৳১');
});

/* ---------------- UI rules, run against the real app.js and whatsapp.js ---------------- */
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function fakeElement() {
  return {
    innerHTML: '', textContent: '', className: '', title: '', value: '', hidden: false, dataset: {}, files: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
}
class FakeFormData { constructor(f) { this.m = new Map(f && f.fields ? f.fields : []); } get(k) { return this.m.has(k) ? this.m.get(k) : null; } }

function sandboxFor() {
  const els = new Map();
  const $el = sel => { if (!els.has(sel)) els.set(sel, fakeElement()); return els.get(sel); };
  const sb = {
    HISAB_CONFIG: { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' },
    document: {
      documentElement: { dataset: {} }, body: { appendChild() {} }, hidden: false, readyState: 'complete',
      querySelector: $el, querySelectorAll: () => [], getElementById: () => null,
      addEventListener() {}, createElement: () => ({ click() {}, remove() {} }),
    },
    navigator: { onLine: true }, location: { href: 'http://localhost/' },
    indexedDB: { open: () => ({}) },
    confirm: () => true, alert: () => {},
    FormData: FakeFormData, crypto: globalThis.crypto, TextEncoder, atob, Event, URL,
    setTimeout, clearTimeout, setImmediate, Intl, Date, JSON, Math, Map, Set, Promise, console,
    setInterval: (...a) => { const t = setInterval(...a); if (t && t.unref) t.unref(); return t; },
    __opened: [],
  };
  sb.window = sb;
  sb.open = (url) => { sb.__opened.push(url); return null; };
  sb.addEventListener = () => {};
  sb.dispatchEvent = () => true;
  sb.scrollTo = () => {};
  vm.createContext(sb);
  return sb;
}
const fakeDb = () => ({
  transaction() {
    const t = { oncomplete: null, onerror: null, onabort: null, objectStore: () => ({ put() {}, clear() {}, delete() {}, getAll() {} }) };
    setImmediate(() => { if (t.oncomplete) t.oncomplete(); });
    return t;
  },
});

function boot() {
  const ctx = sandboxFor();
  for (const f of ['sync-core.js', 'whatsapp-core.js', 'app.js']) vm.runInContext(read(f), ctx, { filename: f });
  ctx.__db = fakeDb();
  vm.runInContext('db = __db; S.loaded = true;', ctx);
  vm.runInContext(read('whatsapp.js'), ctx, { filename: 'whatsapp.js' });
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
function seed(ctx) {
  ctx.__seed = {
    people: [{ id: 'p1', name: 'রহিম', phone: '01712345678', notes: '', archived: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }],
    txns: [{ id: 't1', personId: 'p1', type: 'lent', amount: 500000, date: '2026-10-01', dueDate: '2026-10-05', category: 'ব্যক্তিগত', note: '',
      voided: false, audit: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }],
  };
  run(ctx, 'S.people = __seed.people; S.txns = __seed.txns; S.loaded = true;');
}
const auditActions = (ctx, id) => JSON.parse(run(ctx, `JSON.stringify(S.txns.find(t => t.id === '${id}').audit)`)).map(a => a.action);
const tick = () => new Promise(r => setImmediate(r));

test('the draft sheet opens prefilled with the saved number and a message built from the live loan', () => {
  const ctx = boot();
  seed(ctx);
  run(ctx, "acts.waTxn({ dataset: { id: 't1' } })");
  const html = run(ctx, "document.querySelector('#sheet').innerHTML");
  assert.match(html, /value="\+8801712345678"/);   // stored 01… number shown in international form
  assert.match(html, /আসসালামু আলাইকুম রহিম/);
  assert.match(html, /৳৫,০০০ পাওনা/);
});

test('opening WhatsApp opens the wa.me draft but records NOTHING as sent', async () => {
  const ctx = boot();
  seed(ctx);
  run(ctx, "acts.waTxn({ dataset: { id: 't1' } })");
  run(ctx, "document.querySelector('#wa-number').value = '01712345678'");
  run(ctx, "document.querySelector('#wa-text').value = 'নমুনা বার্তা & টেস্ট?'");
  run(ctx, "acts.waOpenNow({ dataset: { id: 't1' } })");
  await tick();
  assert.equal(ctx.__opened.length, 1);
  assert.match(ctx.__opened[0], /^https:\/\/wa\.me\/8801712345678\?text=/);
  assert.equal(decodeURIComponent(ctx.__opened[0].split('?text=')[1]), 'নমুনা বার্তা & টেস্ট?');
  assert.equal(auditActions(ctx, 't1').includes('হোয়াটসঅ্যাপ'), false, 'opening must not mark anything as sent');
});

test('an invalid number shows a useful error and WhatsApp is not opened', () => {
  const ctx = boot();
  seed(ctx);
  run(ctx, "acts.waTxn({ dataset: { id: 't1' } })");
  run(ctx, "document.querySelector('#wa-number').value = '0121234567'");
  run(ctx, "document.querySelector('#wa-text').value = 'হ্যালো'");
  run(ctx, "acts.waOpenNow({ dataset: { id: 't1' } })");
  assert.equal(ctx.__opened.length, 0);
  assert.equal(run(ctx, "document.querySelector('#wa-err').hidden"), false);
  assert.match(run(ctx, "document.querySelector('#wa-err').textContent"), /১১ সংখ্যার/);
});

test('an empty message is refused', () => {
  const ctx = boot();
  seed(ctx);
  run(ctx, "acts.waTxn({ dataset: { id: 't1' } })");
  run(ctx, "document.querySelector('#wa-number').value = '01712345678'");
  run(ctx, "document.querySelector('#wa-text').value = '   '");
  run(ctx, "acts.waOpenNow({ dataset: { id: 't1' } })");
  assert.equal(ctx.__opened.length, 0);
  assert.match(run(ctx, "document.querySelector('#wa-err').textContent"), /খালি/);
});

test('a confirmed send is recorded in the audit trail only after the explicit confirmation', async () => {
  const ctx = boot();
  seed(ctx);
  ctx.confirm = () => false;                          // user cancels the confirmation
  run(ctx, "acts.waConfirmSent({ dataset: { id: 't1' } })");
  await tick();
  assert.equal(auditActions(ctx, 't1').includes('হোয়াটসঅ্যাপ'), false, 'cancel records nothing');

  ctx.confirm = () => true;                           // user confirms
  run(ctx, "acts.waConfirmSent({ dataset: { id: 't1' } })");
  await tick();
  assert.equal(auditActions(ctx, 't1').includes('হোয়াটসঅ্যাপ'), true, 'confirmation is recorded');
  assert.equal(run(ctx, "S.txns.find(t => t.id === 't1').dirty"), true, 'the change is queued for sync');
});

test('saving the recipient number stores the normalized international form on the person', async () => {
  const ctx = boot();
  seed(ctx);
  run(ctx, "acts.waTxn({ dataset: { id: 't1' } })");
  run(ctx, "document.querySelector('#wa-number').value = '017-1234-5678'");
  run(ctx, "acts.waSaveNumber({ dataset: { id: 't1' } })");
  await tick();
  assert.equal(run(ctx, "S.people[0].phone"), '+8801712345678');
  assert.equal(run(ctx, "S.people[0].dirty"), true);
});

test('a loan that is fully repaid gets no reminder button, and an overdue one does', () => {
  const ctx = boot();
  seed(ctx);
  assert.equal(run(ctx, "WA.rowButton('t1', 'done', 0)"), '');
  assert.match(run(ctx, "WA.rowButton('t1', 'overdue', 300000)"), /data-act="waTxn"/);
  assert.match(run(ctx, "WA.rowButton('t1', 'upcoming', 300000)"), /WhatsApp/);
  assert.equal(run(ctx, "WA.rowButton('t1', 'later', 300000)"), '');
});

test('the dashboard and the person page show a WhatsApp button beside an overdue loan', () => {
  const ctx = boot();
  seed(ctx);
  const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  run(ctx, `S.txns[0].date = '${day(10)}'; S.txns[0].dueDate = '${day(5)}'`);   // due five days ago
  const dash = run(ctx, 'viewDash()');
  assert.match(dash, /class="row-wrap"/);
  assert.match(dash, /data-act="waTxn" data-id="t1"/, 'dashboard overdue row has the button');
  assert.match(dash, /data-act="person" data-id="p1"/, 'tapping the name still opens the person');
  const page = run(ctx, "viewPerson('p1')");
  assert.match(page, /data-act="waTxn" data-id="t1"/, 'person page loan row has the button');
  assert.match(page, /data-act="txn" data-id="t1"/, 'tapping the loan still opens its details');
});
