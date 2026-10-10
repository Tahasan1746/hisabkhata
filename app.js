/* হিসাবখাতা — local-first personal ledger
 * Money is stored as integer paisa (1 taka = 100). Dates are local YYYY-MM-DD strings.
 * Repayments are pooled per person and applied oldest-loan-first (FIFO). */
'use strict';

/* ---------- helpers ---------- */
const BN = '০১২৩৪৫৬৭৮৯';
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toBn = s => String(s).replace(/\d/g, d => BN[d]);
const toEn = s => String(s ?? '').replace(/[০-৯]/g, d => BN.indexOf(d)).replace(/[,\s]/g, '').trim();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const nowIso = () => new Date().toISOString();
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => ymd(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const dayDiff = (a, b) => Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const fmt = p => {
  const v = Math.abs(p) / 100;
  const s = '৳' + v.toLocaleString('bn-BD', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
  return (p < 0 ? '−' : '') + s;
};
const signed = p => (p > 0 ? '+' : '') + fmt(p);
const parseAmt = s => {
  const t = toEn(s);
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const p = Math.round(parseFloat(t) * 100);
  return p > 0 ? p : null;
};
const fmtDate = iso => (isDate(iso) ? new Date(iso + 'T00:00:00').toLocaleDateString('bn-BD', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
const fmtDT = iso => (iso ? new Date(iso).toLocaleString('bn-BD', { dateStyle: 'medium', timeStyle: 'short' }) : 'নেওয়া হয়নি');
const field = (label, control) => `<label class="field"><span>${label}</span>${control}</label>`;
const emptyBox = (title, text) => `<div class="empty"><b>${title}</b>${text}</div>`;

/* ---------- constants ---------- */
const TYPE_LABEL = { lent: 'টাকা ধার দিয়েছি', borrowed: 'টাকা ধার নিয়েছি', received: 'টাকা গ্রহণ করেছি', paid: 'টাকা পরিশোধ করেছি' };
const REPAY_OF = { received: 'lent', paid: 'borrowed' };   // repayment -> the loan it reduces
const REPAY_TYPE = { lent: 'received', borrowed: 'paid' };  // loan -> its repayment type
const RECV_TYPES = ['lent', 'received'];
const CATEGORIES = ['ব্যক্তিগত', 'ব্যবসা', 'পরিবার', 'কেনাকাটা', 'অন্যান্য'];
const STATUS = {
  overdue: ['মেয়াদোত্তীর্ণ', 'pay'], today: ['আজ শেষ', 'warn'], upcoming: ['আসন্ন', 'warn'],
  later: ['বাকি আছে', ''], nodue: ['শেষ তারিখ নেই', ''], done: ['পরিশোধিত', 'recv'],
};
const DEMO_BLOCK = 'ডেমো ডেটা চালু আছে। আসল তথ্য যোগ করতে আগে সেটিংস থেকে ডেমো ডেটা মুছুন।';
const TABS = [
  { id: 'dash', label: 'ড্যাশবোর্ড', icon: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>' },
  { id: 'people', label: 'ব্যক্তিবর্গ', icon: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-3.9 3.1-6 7-6s7 2.1 7 6"/><path d="M16 4.5a4 4 0 010 7.5"/>' },
  { id: 'txns', label: 'লেনদেন', icon: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>' },
  { id: 'backup', label: 'ব্যাকআপ', icon: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>' },
  { id: 'settings', label: 'সেটিংস', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>' },
];
const DEFAULTS = { key: 'app', theme: 'system', remindDays: 3, overdueAlert: true, lastBackup: null, notified: {} };

const S = {
  loaded: false, people: [], txns: [], app: { ...DEFAULTS },
  ui: { tab: 'dash', personId: null, pf: 'all', tf: 'all', q: '', pending: null, importErr: [] },
};

/* ---------- IndexedDB ---------- */
let db;
const openDB = () => new Promise((res, rej) => {
  const r = indexedDB.open('hisabkhata', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('people', { keyPath: 'id' });
    d.createObjectStore('txns', { keyPath: 'id' });
    d.createObjectStore('app', { keyPath: 'key' });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const dbGetAll = store => new Promise((res, rej) => {
  const req = db.transaction(store, 'readonly').objectStore(store).getAll();
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});
/* ops: [{store, put}] | [{store, del: id}] | [{store, clear: true}] — one atomic transaction */
function dbRun(ops) {
  if (!ops.length) return Promise.resolve();
  return new Promise((res, rej) => {
    const t = db.transaction([...new Set(ops.map(o => o.store))], 'readwrite');
    for (const o of ops) {
      const s = t.objectStore(o.store);
      if (o.clear) s.clear();
      else if (o.del !== undefined) s.delete(o.del);
      else s.put(o.put);
    }
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('লেখা ব্যর্থ হয়েছে'));
  });
}
async function saveApp(patch) {
  S.app = { ...S.app, ...patch };
  await dbRun([{ store: 'app', put: S.app }]);
}

/* write every local record and sync state in one transaction */
async function persistAll() {
  await dbRun([
    { store: 'people', clear: true }, { store: 'txns', clear: true },
    ...S.people.map(p => ({ store: 'people', put: p })),
    ...S.txns.map(t => ({ store: 'txns', put: t })),
    { store: 'app', put: S.app },
  ]);
}
async function load() {
  db = await openDB();
  const [people, txns, app] = await Promise.all([dbGetAll('people'), dbGetAll('txns'), dbGetAll('app')]);
  S.people = people;
  S.txns = txns;
  S.app = { ...DEFAULTS, ...(app.find(a => a.key === 'app') || {}) };
  S.loaded = true;
}
const applyTheme = () => { document.documentElement.dataset.theme = S.app.theme; };

/* ---------- ledger engine ---------- */
function dueStatus(dueDate, remaining) {
  if (remaining <= 0) return 'done';
  if (!isDate(dueDate)) return 'nodue';
  const d = dayDiff(dueDate, todayISO());
  if (d < 0) return 'overdue';
  if (d === 0) return 'today';
  return d <= S.app.remindDays ? 'upcoming' : 'later';
}
/* Per-person ledger. Returns loans with repaid/remaining/status plus totals. */
function ledger(personId, list = S.txns) {
  const mine = list.filter(t => t.personId === personId && !t.voided);
  const out = {};
  for (const lt of ['lent', 'borrowed']) {
    let pool = mine.filter(t => t.type === REPAY_TYPE[lt]).reduce((s, t) => s + t.amount, 0);
    const loans = mine.filter(t => t.type === lt)
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    let total = 0, repaid = 0;
    const items = loans.map(l => {
      const use = Math.min(pool, l.amount);
      pool -= use; total += l.amount; repaid += use;
      const remaining = l.amount - use;
      return { ...l, repaid: use, remaining, status: dueStatus(l.dueDate, remaining) };
    });
    out[lt] = { items, total, repaid, remaining: total - repaid };
  }
  out.recv = out.lent.remaining;
  out.pay = out.borrowed.remaining;
  out.net = out.recv - out.pay;
  out.hasLoans = out.lent.total + out.borrowed.total > 0;
  out.overdue = [...out.lent.items, ...out.borrowed.items].some(i => i.status === 'overdue');
  return out;
}
/* Rejects any state where repayments exceed the loans in that direction (no negative balances). */
function ledgerError(personId, list) {
  const mine = list.filter(t => t.personId === personId && !t.voided);
  const sum = ty => mine.filter(t => t.type === ty).reduce((s, t) => s + t.amount, 0);
  if (sum('received') > sum('lent')) return `বাকি পাওনার চেয়ে বেশি গ্রহণ করা যাবে না। মোট পাওনা ${fmt(sum('lent'))}, মোট গ্রহণ ${fmt(sum('received'))}।`;
  if (sum('paid') > sum('borrowed')) return `বাকি দেনার চেয়ে বেশি পরিশোধ করা যাবে না। মোট দেনা ${fmt(sum('borrowed'))}, মোট পরিশোধ ${fmt(sum('paid'))}।`;
  return null;
}
const activeTxns = () => S.txns.filter(t => !t.voided);
const sumOf = (pid, type) => S.txns.filter(t => !t.voided && t.personId === pid && t.type === type).reduce((s, t) => s + t.amount, 0);
const nameOf = id => (S.people.find(p => p.id === id) || {}).name || '—';
const isDemoActive = () => S.people.some(p => p.demo) || S.txns.some(t => t.demo);

function totals() {
  const T = { recv: 0, pay: 0, net: 0, overdue: 0, month: { got: 0, gave: 0 }, upcoming: [], late: [] };
  const m = todayISO().slice(0, 7);
  for (const p of S.people) {
    const L = ledger(p.id);
    T.recv += L.recv;
    T.pay += L.pay;
    for (const it of [...L.lent.items, ...L.borrowed.items]) {
      if (it.remaining <= 0) continue;
      const row = { ...it, person: p };
      if (it.status === 'overdue') { T.overdue += it.remaining; T.late.push(row); }
      else if (it.status === 'upcoming' || it.status === 'today') T.upcoming.push(row);
    }
  }
  for (const t of activeTxns()) {
    if (!t.date.startsWith(m)) continue;
    if (t.type === 'received') T.month.got += t.amount;
    if (t.type === 'paid') T.month.gave += t.amount;
  }
  const byDue = (a, b) => a.dueDate.localeCompare(b.dueDate);
  T.upcoming.sort(byDue);
  T.late.sort(byDue);
  T.net = T.recv - T.pay;
  return T;
}

/* ---------- audit ---------- */
const audit = (rec, action, detail) => { rec.audit = [...(rec.audit || []), { at: nowIso(), action, detail }]; };
function changeNote(a, b) {
  const parts = [];
  if (a.amount !== b.amount) parts.push(`পরিমাণ ${fmt(a.amount)} → ${fmt(b.amount)}`);
  if (a.date !== b.date) parts.push(`তারিখ ${fmtDate(a.date)} → ${fmtDate(b.date)}`);
  if ((a.dueDate || '') !== (b.dueDate || '')) parts.push(`শেষ তারিখ ${fmtDate(a.dueDate)} → ${fmtDate(b.dueDate)}`);
  return parts.join('; ') || 'তথ্য সম্পাদিত';
}

/* ---------- UI primitives ---------- */
function toast(msg, bad) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.className = ''; }, 2600);
}
function openSheet(title, body) {
  $('#sheet').innerHTML = `
    <div class="scrim" data-act="close"></div>
    <div class="panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="grab"></div>
      <div class="head"><h2>${esc(title)}</h2><button class="btn ghost" data-act="close">বন্ধ করুন</button></div>
      ${body}
    </div>`;
  $('#sheet').classList.add('open');
}
function closeSheet() { $('#sheet').classList.remove('open'); $('#sheet').innerHTML = ''; }
function showErr(form, msgs) {
  const box = form.querySelector('.err');
  if (box) { box.textContent = msgs.join(' '); box.hidden = false; }
  else toast(msgs[0], true);
}

const personRow = (p, L) => {
  const sub = [L.recv ? `পাওনা ${fmt(L.recv)}` : '', L.pay ? `দেনা ${fmt(L.pay)}` : ''].filter(Boolean).join(' · ')
    || (L.hasLoans ? 'সব পরিশোধিত' : 'কোনো হিসাব নেই');
  return `<button class="row" data-act="person" data-id="${p.id}">
    <div class="main"><div class="name">${esc(p.name)}${p.archived ? ' <span class="tag">আর্কাইভ</span>' : ''}${L.overdue ? ' <span class="tag pay">বকেয়া</span>' : ''}</div>
    <div class="muted">${sub}</div></div>
    <div class="amt ${L.net >= 0 ? 'recv' : 'pay'}">${L.hasLoans ? signed(L.net) : '—'}</div></button>`;
};
const txnRow = (t, pname) => `<button class="row${t.voided ? ' void' : ''}" data-act="txn" data-id="${t.id}">
    <div class="main"><div class="name">${esc(pname)}${t.voided ? ' <span class="tag">বাতিল</span>' : ''}</div>
    <div class="muted">${TYPE_LABEL[t.type]} · ${fmtDate(t.date)}${t.note ? ' · ' + esc(t.note) : ''}</div></div>
    <div class="amt ${RECV_TYPES.includes(t.type) ? 'recv' : 'pay'}">${fmt(t.amount)}</div></button>`;
const stat = (label, value, cls = '') => `<div class="stat ${cls}"><div class="l">${label}</div><div class="v">${value}</div></div>`;
const alertRow = r => {
  const [label, cls] = STATUS[r.status];
  const d = dayDiff(r.dueDate, todayISO());
  const when = d < 0 ? `${toBn(-d)} দিন আগে শেষ` : d === 0 ? 'আজ শেষ তারিখ' : `${toBn(d)} দিন বাকি · ${fmtDate(r.dueDate)}`;
  return `<div class="row-wrap">
    <button class="row-main" data-act="person" data-id="${r.person.id}">
      <div class="main"><div class="name">${esc(r.person.name)}<span class="tag ${cls}">${label}</span></div>
      <div class="muted">${TYPE_LABEL[r.type]} · ${when}</div></div>
      <div class="amt ${RECV_TYPES.includes(r.type) ? 'recv' : 'pay'}">${fmt(r.remaining)}</div>
    </button>
    ${window.WA ? WA.rowButton(r.id, r.status, r.remaining) : ''}
  </div>`;
};

/* ---------- screens ---------- */
function viewDash() {
  const T = totals();
  const head = `<div class="head"><div><h1>ড্যাশবোর্ড</h1>
    ${window.CloudUI ? CloudUI.statusPill() : ''}<div class="muted">শেষ ব্যাকআপ: ${S.app.lastBackup ? fmtDT(S.app.lastBackup) : 'নেওয়া হয়নি'}</div></div></div>`;
  if (!S.people.length) {
    return head + emptyBox('স্বাগতম', 'প্রথমে একজন ব্যক্তি যোগ করুন, তারপর পাওনা বা দেনা লিখুন।') +
      `<button class="btn block" data-act="addPerson">নতুন ব্যক্তি যোগ করুন</button>
       <p class="muted" style="text-align:center;margin-top:14px">উদাহরণ দেখতে চান? <button class="linkbtn" data-act="tab" data-tab="settings">সেটিংসে ডেমো ডেটা</button></p>`;
  }
  const nl = T.net > 0 ? 'নিট পাওনা' : T.net < 0 ? 'নিট দেনা' : 'হিসাব সমান';
  const names = Object.fromEntries(S.people.map(p => [p.id, p.name]));
  const recent = activeTxns().slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  return head
    + (isDemoActive() ? `<div class="notice">ডেমো ডেটা চালু আছে। আসল তথ্য যোগ করার আগে সেটিংস থেকে এটি মুছুন।</div>` : '')
    + `<section class="hero"><div class="muted">${nl}</div><div class="amt-hero ${T.net >= 0 ? 'recv' : 'pay'}">${fmt(Math.abs(T.net))}</div></section>
    <div class="stats">
      ${stat('মোট পাওনা', fmt(T.recv), 'recv')}
      ${stat('মোট দেনা', fmt(T.pay), 'pay')}
      ${stat('এই মাসে পেয়েছি', fmt(T.month.got), 'recv')}
      ${stat('এই মাসে দিয়েছি', fmt(T.month.gave), 'pay')}
      ${stat('মোট বকেয়া (মেয়াদোত্তীর্ণ)', fmt(T.overdue), 'pay')}
      ${stat('আসন্ন পেমেন্ট', toBn(T.upcoming.length) + ' টি', 'warn')}
    </div>
    <div class="acts">
      <button class="act" data-act="newTxn" data-type="lent">নতুন পাওনা</button>
      <button class="act" data-act="newTxn" data-type="borrowed">নতুন দেনা</button>
      <button class="act" data-act="newTxn" data-type="received">টাকা গ্রহণ</button>
      <button class="act" data-act="newTxn" data-type="paid">টাকা পরিশোধ</button>
      <button class="act wide" data-act="addPerson">নতুন ব্যক্তি যোগ</button>
    </div>
    <h2>মেয়াদোত্তীর্ণ পাওনা ও দেনা</h2>
    ${T.late.length ? T.late.map(alertRow).join('') : emptyBox('কোনো মেয়াদোত্তীর্ণ হিসাব নেই', 'ভালো খবর: কোনো শেষ তারিখ পার হয়নি।')}
    <h2>আসন্ন পেমেন্ট (${toBn(S.app.remindDays)} দিনের মধ্যে)</h2>
    ${T.upcoming.length ? T.upcoming.map(alertRow).join('') : emptyBox('আসন্ন কোনো পেমেন্ট নেই', 'শেষ তারিখ সহ লেনদেন যোগ করলে এখানে দেখাবে।')}
    <h2>সাম্প্রতিক লেনদেন</h2>
    ${recent.length ? recent.map(t => txnRow(t, names[t.personId] || '—')).join('') : emptyBox('এখনও কোনো লেনদেন নেই', 'পাওনা বা দেনা লিখে শুরু করুন।')}`;
}

let peopleTimer;
function viewPeople() {
  const chips = [['all', 'সব'], ['recv', 'পাওনা'], ['pay', 'দেনা'], ['overdue', 'বকেয়া'], ['done', 'পরিশোধ সম্পন্ন'], ['archived', 'আর্কাইভ']];
  return `<div class="head"><h1>ব্যক্তিবর্গ</h1><button class="btn" data-act="addPerson">নতুন ব্যক্তি</button></div>
    <input type="search" id="q" class="search" placeholder="নাম বা ফোন নম্বর খুঁজুন" value="${esc(S.ui.q)}">
    <div class="chips">${chips.map(([v, l]) => `<button class="chip" aria-pressed="${S.ui.pf === v}" data-act="chip" data-scope="pf" data-v="${v}">${l}</button>`).join('')}</div>
    <div id="plist">${peopleList()}</div>`;
}
function peopleList() {
  if (!S.people.length) return emptyBox('এখনও কোনো ব্যক্তি নেই', 'উপরের “নতুন ব্যক্তি” বাটন চাপুন।');
  const q = S.ui.q.trim().toLowerCase(), f = S.ui.pf;
  const rows = S.people.map(p => ({ p, L: ledger(p.id) })).filter(({ p, L }) => {
    if (q && !(p.name.toLowerCase().includes(q) || (p.phone || '').includes(toEn(q)))) return false;
    if (f === 'archived') return p.archived;
    if (p.archived) return false;
    if (f === 'recv') return L.recv > 0;
    if (f === 'pay') return L.pay > 0;
    if (f === 'overdue') return L.overdue;
    if (f === 'done') return L.hasLoans && L.recv === 0 && L.pay === 0;
    return true;
  }).sort((a, b) => a.p.name.localeCompare(b.p.name, 'bn'));
  if (!rows.length) return emptyBox('কিছু পাওয়া যায়নি', 'অন্য ফিল্টার বা নাম দিয়ে খুঁজুন।');
  return rows.map(({ p, L }) => personRow(p, L)).join('');
}

function viewPerson(id) {
  const p = S.people.find(x => x.id === id);
  if (!p) { S.ui.personId = null; return viewPeople(); }
  const L = ledger(p.id);
  const loans = [...L.lent.items, ...L.borrowed.items].sort((a, b) => b.date.localeCompare(a.date));
  const hist = S.txns.filter(t => t.personId === p.id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const loanRow = l => {
    const [label, cls] = STATUS[l.status];
    const pct = l.amount ? Math.round((l.repaid / l.amount) * 100) : 0;
    return `<div class="row-wrap"><button class="row-main" data-act="txn" data-id="${l.id}">
      <div class="main"><div class="name">${TYPE_LABEL[l.type]}</div>
      <div class="muted">${fmtDate(l.date)}${l.dueDate ? ' · শেষ: ' + fmtDate(l.dueDate) : ''} · পরিশোধ ${toBn(pct)}%</div>
      <div class="bar ${l.type === 'borrowed' ? 'pay' : ''}"><i style="width:${pct}%"></i></div></div>
      <div class="side"><div class="amt ${RECV_TYPES.includes(l.type) ? 'recv' : 'pay'}">${fmt(l.remaining)}</div><span class="tag ${cls}">${label}</span></div></button>${window.WA ? WA.rowButton(l.id, l.status, l.remaining) : ''}</div>`;
  };
  return `<div class="head"><div><h1>${esc(p.name)}</h1>
      <div class="muted">${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : 'ফোন নম্বর নেই'}${p.notes ? ' · ' + esc(p.notes) : ''}</div></div>
      <button class="btn ghost" data-act="back">ফিরে যান</button></div>
    <div class="stats">
      ${stat('বাকি পাওনা', fmt(L.recv), 'recv')}
      ${stat('বাকি দেনা', fmt(L.pay), 'pay')}
      ${stat('মোট ধার দিয়েছি', fmt(L.lent.total))}
      ${stat('মোট ধার নিয়েছি', fmt(L.borrowed.total))}
      ${stat('মোট গ্রহণ', fmt(sumOf(p.id, 'received')), 'recv')}
      ${stat('মোট পরিশোধ', fmt(sumOf(p.id, 'paid')), 'pay')}
    </div>
    <div class="muted">নিট হিসাব: <b class="${L.net >= 0 ? 'recv' : 'pay'}">${signed(L.net)}</b></div>
    <div class="acts">
      <button class="act" data-act="newTxn" data-type="lent" data-person="${p.id}">টাকা ধার দিয়েছি</button>
      <button class="act" data-act="newTxn" data-type="borrowed" data-person="${p.id}">টাকা ধার নিয়েছি</button>
      <button class="act" data-act="newTxn" data-type="received" data-person="${p.id}">টাকা গ্রহণ</button>
      <button class="act" data-act="newTxn" data-type="paid" data-person="${p.id}">টাকা পরিশোধ</button>
    </div>
    <div class="row-actions">
      <button class="btn ghost" data-act="editPerson" data-id="${p.id}">তথ্য সম্পাদনা</button>
      <button class="btn ghost" data-act="archive" data-id="${p.id}">${p.archived ? 'সক্রিয় করুন' : 'আর্কাইভ করুন'}</button>
    </div>
    <h2>ধার ও হিসাব (${toBn(loans.length)})</h2>
    ${loans.length ? loans.map(loanRow).join('') : emptyBox('কোনো ধার নেই', 'উপরের বাটন দিয়ে পাওনা বা দেনা যোগ করুন।')}
    <h2>সব লেনদেন</h2>
    ${hist.length ? hist.map(t => txnRow(t, p.name)).join('') : emptyBox('কোনো লেনদেন নেই', 'প্রথম লেনদেন যোগ করুন।')}`;
}

function viewTxns() {
  const chips = [['all', 'সব'], ['lent', 'পাওনা'], ['borrowed', 'দেনা'], ['received', 'গ্রহণ'], ['paid', 'পরিশোধ'], ['void', 'বাতিল']];
  const f = S.ui.tf;
  const list = S.txns.filter(t => (f === 'void' ? t.voided : (!t.voided && (f === 'all' || t.type === f))))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  return `<div class="head"><h1>লেনদেন</h1><button class="btn" data-act="newTxn">নতুন লেনদেন</button></div>
    <div class="chips">${chips.map(([v, l]) => `<button class="chip" aria-pressed="${f === v}" data-act="chip" data-scope="tf" data-v="${v}">${l}</button>`).join('')}</div>
    ${list.length ? list.map(t => txnRow(t, nameOf(t.personId))).join('') : emptyBox('কোনো লেনদেন নেই', 'নতুন লেনদেন যোগ করে শুরু করুন।')}`;
}

function viewBackup() {
  return `<div class="head"><div><h1>ব্যাকআপ</h1>
    <div class="muted">শেষ ব্যাকআপ: ${S.app.lastBackup ? fmtDT(S.app.lastBackup) : 'নেওয়া হয়নি'}</div></div></div>
    <h2>ফাইলে ব্যাকআপ (JSON)</h2>
    <p class="muted">সব ব্যক্তি ও লেনদেন একটি ফাইলে নামানো হবে। ফাইলে কোনো পাসওয়ার্ড বা গোপন কী থাকে না।</p>
    <button class="btn block" data-act="exportJSON">ব্যাকআপ ফাইল ডাউনলোড</button>
    <h2>ফাইল থেকে পুনরুদ্ধার</h2>
    <p class="muted">ফাইল যাচাই করে কী বদলাবে তা আগে দেখানো হবে। নিশ্চিত না হওয়া পর্যন্ত কিছু বদলাবে না।</p>
    <input type="file" id="importFile" accept="application/json,.json">
    ${importPreviewHTML()}
    ${window.CloudUI ? CloudUI.backupHTML() : ''}`;
}

function viewSettings() {
  const th = S.app.theme;
  const radio = (v, l) => `<label><input type="radio" name="theme" value="${v}" ${th === v ? 'checked' : ''}><span>${l}</span></label>`;
  const notifState = !('Notification' in window) ? 'এই ব্রাউজারে সমর্থিত নয়'
    : ({ granted: 'চালু', denied: 'ব্রাউজার থেকে বন্ধ করা আছে', default: 'এখনও অনুমতি দেওয়া হয়নি' })[Notification.permission];
  const canAsk = 'Notification' in window && Notification.permission !== 'granted';
  return `<div class="head"><h1>সেটিংস</h1></div>
    <form data-form="settings">
      <h2>থিম</h2>
      <div class="seg">${radio('system', 'সিস্টেম')}${radio('light', 'হালকা')}${radio('dark', 'গাঢ়')}</div>
      <h2>রিমাইন্ডার</h2>
      ${field('শেষ তারিখের কত দিন আগে জানাবেন (১-৩০)', `<input name="remindDays" inputmode="numeric" value="${toBn(S.app.remindDays)}">`)}
      <label class="check"><input type="checkbox" name="overdueAlert" ${S.app.overdueAlert ? 'checked' : ''}><span>শেষ তারিখ পার হলে জানান</span></label>
      <div class="err" hidden></div>
      <button class="btn block" type="submit">সেটিংস সংরক্ষণ করুন</button>
    </form>
    ${window.CloudUI ? CloudUI.settingsHTML() : ''}
    <h2>নোটিফিকেশন</h2>
    <p class="muted">অবস্থা: ${notifState}। অ্যাপ খোলা থাকলে বা ফিরে এলে রিমাইন্ডার দেখানো হয়। অ্যাপ সম্পূর্ণ বন্ধ থাকলে নোটিফিকেশন আসবে না; সেটি সার্ভার বা ক্লাউড যুক্ত হলে সম্ভব।</p>
    ${canAsk ? '<button class="btn ghost block" data-act="notifPerm">নোটিফিকেশন চালু করুন</button>' : ''}
    <h2>ডেমো ডেটা</h2>
    <p class="muted">উদাহরণ তথ্য দিয়ে অ্যাপ ঘুরে দেখুন। ডেমো তথ্য আসল তথ্যের সাথে মেশে না।</p>
    <div class="stack">
      <button class="btn ghost block" data-act="demoLoad">ডেমো ডেটা যোগ করুন</button>
      <button class="btn ghost block" data-act="demoClear">ডেমো ডেটা মুছুন</button>
    </div>
    <h2>বিপজ্জনক এলাকা</h2>
    <button class="btn danger block" data-act="resetAll">সব তথ্য মুছুন</button>
    <p class="muted" style="margin-top:18px">সংস্করণ ১.০ · স্টোরেজ: এই ডিভাইসের ব্রাউজার (IndexedDB) · ক্লাউড সিঙ্ক: বন্ধ</p>`;
}

/* ---------- person & transaction forms ---------- */
function openPersonForm(id) {
  const p = id ? S.people.find(x => x.id === id) : null;
  openSheet(p ? 'ব্যক্তির তথ্য সম্পাদনা' : 'নতুন ব্যক্তি', `
    <form data-form="person">
      <input type="hidden" name="id" value="${esc(p ? p.id : '')}">
      ${field('নাম', `<input name="name" maxlength="80" value="${esc(p ? p.name : '')}" placeholder="যেমন: রহিম" autocomplete="off">`)}
      ${field('ফোন নম্বর (ঐচ্ছিক)', `<input name="phone" inputmode="tel" value="${esc(p ? p.phone : '')}" placeholder="০১৭XXXXXXXX">`)}
      ${field('নোট (ঐচ্ছিক)', `<textarea name="notes" rows="2" maxlength="500">${esc(p ? p.notes : '')}</textarea>`)}
      <div class="err" hidden></div>
      <button class="btn block" type="submit">সংরক্ষণ করুন</button>
    </form>`);
}

function openTypePicker(personId) {
  openSheet('নতুন লেনদেন', `<div class="acts">${Object.keys(TYPE_LABEL).map(t =>
    `<button class="act" data-act="newTxn" data-type="${t}"${personId ? ` data-person="${personId}"` : ''}>${TYPE_LABEL[t]}</button>`).join('')}</div>`);
}

function openTxnForm({ id, type, personId } = {}) {
  if (!S.people.length) {
    return openSheet('প্রথমে ব্যক্তি যোগ করুন', `<p class="muted">লেনদেন লিখতে আগে একজন ব্যক্তি যোগ করুন।</p>
      <button class="btn block" data-act="addPerson">নতুন ব্যক্তি যোগ করুন</button>`);
  }
  const old = id ? S.txns.find(t => t.id === id) : null;
  const ty = old ? old.type : type;
  if (!TYPE_LABEL[ty]) return;
  const pid = old ? old.personId : (personId && S.people.some(p => p.id === personId) ? personId : S.people[0].id);
  const isRepay = !!REPAY_OF[ty];
  const choices = S.people.filter(p => !p.archived || p.id === pid);
  const personField = old
    ? `<input type="hidden" name="personId" value="${esc(pid)}"><div class="ro">${esc(nameOf(pid))}</div>`
    : `<select name="personId">${choices.map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
  const cat = old ? old.category : 'ব্যক্তিগত';
  openSheet(old ? 'লেনদেন সম্পাদনা' : TYPE_LABEL[ty], `
    <form data-form="txn">
      <input type="hidden" name="id" value="${esc(old ? old.id : '')}">
      <input type="hidden" name="type" value="${ty}">
      ${field('ব্যক্তি', personField)}
      ${field('পরিমাণ (৳)', `<input name="amount" inputmode="decimal" value="${old ? old.amount / 100 : ''}" placeholder="যেমন ৫০০০">`)}
      ${field('লেনদেনের তারিখ', `<input type="date" name="date" value="${old ? old.date : todayISO()}">`)}
      ${isRepay ? '' : field('শেষ তারিখ (ঐচ্ছিক)', `<input type="date" name="dueDate" value="${old && old.dueDate ? old.dueDate : ''}">`)}
      ${field('ধরন', `<select name="category">${CATEGORIES.map(c => `<option ${c === cat ? 'selected' : ''}>${c}</option>`).join('')}</select>`)}
      ${field('নোট (ঐচ্ছিক)', `<textarea name="note" rows="2" maxlength="300">${esc(old ? old.note : '')}</textarea>`)}
      <p class="muted">${isRepay
        ? 'এই টাকা স্বয়ংক্রিয়ভাবে সবচেয়ে পুরনো বাকি হিসাব থেকে কাটা হবে।'
        : 'শেষ তারিখ দিলে আসন্ন ও মেয়াদোত্তীর্ণ রিমাইন্ডার পাবেন।'}</p>
      <div class="err" hidden></div>
      <button class="btn block" type="submit">সংরক্ষণ করুন</button>
    </form>`);
}

function openTxnDetail(id) {
  const t = S.txns.find(x => x.id === id);
  if (!t) return;
  const p = S.people.find(x => x.id === t.personId);
  const L = ledger(t.personId);
  const item = !REPAY_OF[t.type] ? (L[t.type].items || []).find(i => i.id === t.id) : null;
  openSheet(TYPE_LABEL[t.type], `
    <div class="amt-hero ${RECV_TYPES.includes(t.type) ? 'recv' : 'pay'}">${fmt(t.amount)}</div>
    ${t.voided ? '<p class="err">এই লেনদেন বাতিল করা হয়েছে।</p>' : ''}
    <div class="kv"><span>ব্যক্তি</span><b><button class="linkbtn" data-act="person" data-id="${t.personId}">${esc(p ? p.name : '—')}</button></b></div>
    <div class="kv"><span>তারিখ</span><b>${fmtDate(t.date)}</b></div>
    ${t.dueDate ? `<div class="kv"><span>শেষ তারিখ</span><b>${fmtDate(t.dueDate)}</b></div>` : ''}
    <div class="kv"><span>ক্যাটাগরি</span><b>${esc(t.category)}</b></div>
    ${t.note ? `<div class="kv"><span>নোট</span><b>${esc(t.note)}</b></div>` : ''}
    ${item ? `<div class="kv"><span>পরিশোধ হয়েছে</span><b>${fmt(item.repaid)}</b></div>
              <div class="kv"><span>বাকি</span><b>${fmt(item.remaining)}</b></div>
              <div class="kv"><span>অবস্থা</span><b>${STATUS[item.status][0]}</b></div>` : ''}
    <div class="row-actions" style="margin-top:16px">
      ${t.voided
        ? `<button class="btn" data-act="restoreTxn" data-id="${t.id}">ফিরিয়ে আনুন</button>`
        : `<button class="btn ghost" data-act="editTxn" data-id="${t.id}">সম্পাদনা</button>
           <button class="btn danger" data-act="voidTxn" data-id="${t.id}">বাতিল করুন</button>`}
    </div>
    ${window.WA ? WA.sectionHTML(t) : ''}
    <h2>ইতিহাস</h2>
    ${(t.audit || []).length
      ? [...t.audit].reverse().map(a => `<div class="kv"><span>${esc(a.action)}</span><b>${esc(a.detail)}</b></div><div class="muted small" style="margin-bottom:6px">${fmtDT(a.at)}</div>`).join('')
      : '<p class="muted">কোনো ইতিহাস নেই।</p>'}`);
}

/* ---------- save operations ---------- */
async function savePerson(f) {
  const fd = new FormData(f);
  const id = String(fd.get('id') || '');
  const old = id ? S.people.find(p => p.id === id) : null;
  const name = String(fd.get('name') || '').trim();
  const phoneRaw = String(fd.get('phone') || '').trim();
  const phone = toEn(phoneRaw);
  const notes = String(fd.get('notes') || '').trim().slice(0, 500);
  const errs = [];
  if (!name) errs.push('নাম লিখুন।');
  if (name.length > 80) errs.push('নাম ৮০ অক্ষরের বেশি হতে পারে না।');
  if (phone && !/^\+?[0-9-]{7,20}$/.test(phone)) errs.push('সঠিক ফোন নম্বর লিখুন (যেমন ০১৭XXXXXXXX)।');
  if (errs.length) return showErr(f, errs);
  if (!old && isDemoActive()) return showErr(f, [DEMO_BLOCK]);
  if (!old && S.people.some(p => !p.archived && p.name.toLowerCase() === name.toLowerCase())
    && !confirm('এই নামে আরেকজন ব্যক্তি আছে। তবুও যোগ করবেন?')) return;
  const rec = { ...(old || { id: uid(), archived: false, createdAt: nowIso() }), name, phone, notes, updatedAt: nowIso() };
  HisabSync.touch(rec);
  await dbRun([{ store: 'people', put: rec }]);
  S.people = old ? S.people.map(p => (p.id === rec.id ? rec : p)) : [...S.people, rec];
  closeSheet();
  S.ui.tab = 'people';
  S.ui.personId = rec.id;
  toast('ব্যক্তির তথ্য সংরক্ষিত হয়েছে');
  if (window.Cloud) Cloud.changed();
  render();
}

async function toggleArchive(id) {
  const p = S.people.find(x => x.id === id);
  if (!p) return;
  const rec = { ...p, archived: !p.archived, updatedAt: nowIso() };
  HisabSync.touch(rec);
  await dbRun([{ store: 'people', put: rec }]);
  S.people = S.people.map(x => (x.id === id ? rec : x));
  toast(rec.archived ? 'ব্যক্তিকে আর্কাইভ করা হয়েছে' : 'ব্যক্তিকে সক্রিয় করা হয়েছে');
  if (window.Cloud) Cloud.changed();
  render();
}

async function saveTxn(f) {
  const fd = new FormData(f);
  const editId = String(fd.get('id') || '');
  const old = editId ? S.txns.find(t => t.id === editId) : null;
  const type = old ? old.type : String(fd.get('type') || '');
  const personId = old ? old.personId : String(fd.get('personId') || '');
  const amount = parseAmt(fd.get('amount'));
  const date = String(fd.get('date') || '');
  const dueDate = REPAY_OF[type] ? null : (String(fd.get('dueDate') || '') || null);
  const errs = [];
  if (!S.people.some(p => p.id === personId)) errs.push('ব্যক্তি নির্বাচন করুন।');
  if (!TYPE_LABEL[type]) errs.push('লেনদেনের ধরন বোঝা যাচ্ছে না।');
  if (amount === null) errs.push('পরিমাণ লিখুন (০ এর বেশি, যেমন ৫০০০ বা ৫০০০.৫০)।');
  if (!isDate(date)) errs.push('লেনদেনের তারিখ দিন।');
  if (dueDate && !isDate(dueDate)) errs.push('শেষ তারিখ সঠিক নয়।');
  if (dueDate && dueDate < date) errs.push('শেষ তারিখ লেনদেনের তারিখের আগে হতে পারে না।');
  if (errs.length) return showErr(f, errs);
  const pDemo = !!S.people.find(p => p.id === personId).demo;
  if (!pDemo && isDemoActive()) return showErr(f, [DEMO_BLOCK]);

  const base = old ? { ...old } : { id: uid(), personId, type, createdAt: nowIso(), voided: false, audit: [] };
  if (pDemo) base.demo = true;
  const rec = {
    ...base, amount, date, dueDate,
    category: String(fd.get('category') || 'অন্যান্য'),
    note: String(fd.get('note') || '').trim().slice(0, 300),
    updatedAt: nowIso(),
  };
  HisabSync.touch(rec);
  const dup = S.txns.find(t => !t.voided && t.id !== rec.id && t.personId === rec.personId
    && t.type === rec.type && t.amount === rec.amount && t.date === rec.date);
  if (dup && !confirm('একই ব্যক্তি, ধরন, পরিমাণ ও তারিখে লেনদেন আগেই আছে। তবুও সেভ করবেন?')) return;

  const next = old ? S.txns.map(t => (t.id === rec.id ? rec : t)) : [...S.txns, rec];
  const err = ledgerError(rec.personId, next);
  if (err) return showErr(f, [err]);
  audit(rec, old ? 'সম্পাদনা' : 'তৈরি', old ? changeNote(old, rec) : `${TYPE_LABEL[type]} · ${fmt(amount)}`);
  await dbRun([{ store: 'txns', put: rec }]);
  S.txns = next;
  closeSheet();
  toast('লেনদেন সংরক্ষিত হয়েছে');
  if (window.Cloud) Cloud.changed();
  render();
  checkReminders().catch(() => {});
}

async function setVoided(id, flag) {
  const t = S.txns.find(x => x.id === id);
  if (!t) return;
  const next = S.txns.map(x => (x.id === id ? { ...x, voided: flag } : x));
  const err = ledgerError(t.personId, next);
  if (err) return toast(`${err} আগে সংশ্লিষ্ট পরিশোধ বাতিল করুন।`, true);
  if (flag && !confirm('এই লেনদেন বাতিল করবেন? ইতিহাসে থেকে যাবে।')) return;
  const rec = { ...t, voided: flag, updatedAt: nowIso() };
  HisabSync.touch(rec);
  audit(rec, flag ? 'বাতিল' : 'পুনরুদ্ধার', flag ? 'ব্যবহারকারী বাতিল করেছেন' : 'ব্যবহারকারী ফিরিয়ে এনেছেন');
  await dbRun([{ store: 'txns', put: rec }]);
  S.txns = next.map(x => (x.id === id ? rec : x));
  closeSheet();
  toast(flag ? 'লেনদেন বাতিল করা হয়েছে' : 'লেনদেন ফিরিয়ে আনা হয়েছে');
  if (window.Cloud) Cloud.changed();
  render();
  checkReminders().catch(() => {});
}

async function saveSettings(f) {
  const fd = new FormData(f);
  const days = parseInt(toEn(fd.get('remindDays')), 10);
  if (!(days >= 1 && days <= 30)) return toast('রিমাইন্ডারের দিন ১ থেকে ৩০ এর মধ্যে দিন।', true);
  const theme = ['system', 'light', 'dark'].includes(fd.get('theme')) ? fd.get('theme') : 'system';
  await saveApp({ theme, remindDays: days, overdueAlert: fd.get('overdueAlert') === 'on' });
  applyTheme();
  toast('সেটিংস সংরক্ষিত হয়েছে');
  render();
  checkReminders().catch(() => {});
}

/* ---------- demo data (kept separate; removable as a unit) ---------- */
async function demoLoad() {
  if (S.people.length || S.txns.length) return toast('ডেমো যোগ করতে আগে সব তথ্য মুছুন বা ব্যাকআপ নিন।', true);
  const T = n => addDays(todayISO(), n);
  const people = [
    { name: 'রহিম', phone: '01700000001' },
    { name: 'করিম', phone: '01800000002' },
    { name: 'সালমা', phone: '01900000003' },
  ].map(p => ({ id: uid(), ...p, notes: 'ডেমো ব্যক্তি', archived: false, demo: true, createdAt: nowIso(), updatedAt: nowIso() }));
  const [rahim, karim, salma] = people;
  const tx = (p, type, amount, date, dueDate = null, note = '') => ({
    id: uid(), personId: p.id, type, amount, date, dueDate: REPAY_OF[type] ? null : dueDate,
    category: 'ব্যক্তিগত', note, voided: false, createdAt: nowIso(), updatedAt: nowIso(), audit: [], demo: true,
  });
  const txns = [
    tx(rahim, 'lent', 500000, T(-30), T(-5), 'ব্যবসার জন্য ধার'),
    tx(rahim, 'received', 200000, T(-10), null, 'প্রথম কিস্তি'),
    tx(karim, 'lent', 300000, T(-20), T(2)),
    tx(karim, 'borrowed', 400000, T(-15), T(10)),
    tx(karim, 'paid', 150000, T(-3), null, 'আংশিক পরিশোধ'),
    tx(salma, 'lent', 100000, T(-60), T(-45)),
    tx(salma, 'received', 100000, T(-50), null, 'সম্পূর্ণ গ্রহণ'),
  ];
  await dbRun([...people.map(p => ({ store: 'people', put: p })), ...txns.map(t => ({ store: 'txns', put: t }))]);
  S.people = people;
  S.txns = txns;
  toast('ডেমো ডেটা যোগ হয়েছে');
  render();
}
async function demoClear() {
  if (!isDemoActive()) return toast('কোনো ডেমো ডেটা নেই।');
  if (!confirm('ডেমো ডেটা মুছে যাবে। আসল তথ্যে কোনো প্রভাব পড়বে না।')) return;
  const ops = [
    ...S.people.filter(p => p.demo).map(p => ({ store: 'people', del: p.id })),
    ...S.txns.filter(t => t.demo).map(t => ({ store: 'txns', del: t.id })),
  ];
  await dbRun(ops);
  S.people = S.people.filter(p => !p.demo);
  S.txns = S.txns.filter(t => !t.demo);
  toast('ডেমো ডেটা মুছে ফেলা হয়েছে');
  render();
}

async function resetAll() {
  const cloudOn = !!(window.Cloud && Cloud.hasOwner());
  const msg = cloudOn
    ? 'সব ব্যক্তি ও লেনদেন মুছে যাবে। ক্লাউডে সংরক্ষিত তথ্যও পরের সিঙ্কে মুছে যাবে। আগে ব্যাকআপ নিয়েছেন তো?'
    : 'সব ব্যক্তি ও লেনদেন মুছে যাবে এবং ফেরত আনা যাবে না। আগে ব্যাকআপ নিয়েছেন তো?';
  if (!confirm(msg)) return;
  S.app.sync = HisabSync.tombsForReset(S.people, S.txns, S.app.sync);
  S.people = [];
  S.txns = [];
  await dbRun([{ store: 'people', clear: true }, { store: 'txns', clear: true }]);
  await saveApp({ notified: {}, sync: S.app.sync });
  S.ui.personId = null;
  toast('সব তথ্য মুছে ফেলা হয়েছে');
  render();
  if (window.Cloud) Cloud.changed();
}

/* ---------- backup: export, validate, merge/replace ---------- */
function exportJSON() {
  if (isDemoActive()) return toast('ডেমো ডেটা রপ্তানি হবে না। সেটিংস থেকে মুছুন।', true);
  const plain = o => { const c = { ...o }; delete c.demo; return c; };
  const payload = HisabSync.buildPayload(S.people, S.txns, nowIso());
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `hisabkhata-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  saveApp({ lastBackup: nowIso() }).then(() => { toast('ব্যাকআপ ফাইল তৈরি হয়েছে। ডাউনলোড ফোল্ডার দেখুন।'); render(); });
}

const isSecretKey = k => /token|password|passwd|secret|service[_-]?role|api[_-]?key/i.test(k);
function hasSecret(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return false;
  return Object.entries(o).some(([k, v]) => isSecretKey(k) || hasSecret(v, depth + 1));
}
/* Returns {errs, people, txns}. Cleans every record so only known fields are stored. */
function validateBackup(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { errs: ['ফাইলটি সঠিক JSON নয়।'] };
  if (obj.app !== 'hisabkhata' || obj.version !== 1) return { errs: ['এটি হিসাবখাতার ব্যাকআপ ফাইল নয়, অথবা সংস্করণ মেলে না।'] };
  if (hasSecret(obj)) return { errs: ['ফাইলে গোপন তথ্য (টোকেন, পাসওয়ার্ড বা কী) পাওয়া গেছে। এই ফাইল ইমপোর্ট করা হবে না।'] };
  if (!Array.isArray(obj.people) || !Array.isArray(obj.txns)) return { errs: ['ব্যক্তি বা লেনদেনের তালিকা পাওয়া যায়নি।'] };

  const people = [], txns = [], pIds = new Set(), tIds = new Set();
  for (const p of obj.people) {
    const ok = p && typeof p.id === 'string' && p.id && typeof p.name === 'string' && p.name.trim() && p.name.trim().length <= 80
      && (!p.phone || /^\+?[0-9-]{7,20}$/.test(String(p.phone)));
    if (!ok) return { errs: ['একটি ব্যক্তির তথ্য সঠিক নয়।'] };
    if (pIds.has(p.id)) return { errs: ['একই ID একাধিক ব্যক্তির জন্য আছে।'] };
    pIds.add(p.id);
    people.push({ id: p.id, name: p.name.trim(), phone: String(p.phone || ''), notes: String(p.notes || '').slice(0, 500),
      archived: !!p.archived, createdAt: p.createdAt || nowIso(), updatedAt: p.updatedAt || nowIso() });
  }
  for (const t of obj.txns) {
    const ok = t && typeof t.id === 'string' && t.id && pIds.has(t.personId) && TYPE_LABEL[t.type]
      && Number.isSafeInteger(t.amount) && t.amount > 0 && isDate(t.date)
      && (!t.dueDate || (isDate(t.dueDate) && t.dueDate >= t.date));
    if (!ok) return { errs: ['একটি লেনদেনের তথ্য সঠিক নয় (ব্যক্তি, ধরন, পরিমাণ বা তারিখ দেখুন)।'] };
    if (tIds.has(t.id)) return { errs: ['একই ID একাধিক লেনদেনের জন্য আছে।'] };
    tIds.add(t.id);
    txns.push({ id: t.id, personId: t.personId, type: t.type, amount: t.amount, date: t.date,
      dueDate: REPAY_OF[t.type] ? null : (t.dueDate || null), category: String(t.category || 'অন্যান্য').slice(0, 30),
      note: String(t.note || '').slice(0, 300), voided: !!t.voided, createdAt: t.createdAt || nowIso(),
      updatedAt: t.updatedAt || nowIso(), audit: Array.isArray(t.audit) ? t.audit : [] });
  }
  for (const p of people) {
    const e = ledgerError(p.id, txns);
    if (e) return { errs: [`${p.name}: ${e}`] };
  }
  return { errs: [], people, txns };
}
/* Compares file records with local ones. Ignores timestamps and audit when judging "same". */
const sig = r => JSON.stringify(Object.keys(r).filter(k => k !== 'updatedAt' && k !== 'audit').sort().map(k => [k, r[k]]));
function planMerge(imp) {
  const res = { people: { add: [], same: 0, conflict: [] }, txns: { add: [], same: 0, conflict: [] } };
  const local = { people: new Map(S.people.map(x => [x.id, x])), txns: new Map(S.txns.map(x => [x.id, x])) };
  for (const k of ['people', 'txns']) {
    for (const rec of imp[k]) {
      const cur = local[k].get(rec.id);
      if (!cur) res[k].add.push(rec);
      else if (sig(cur) === sig(rec)) res[k].same++;
      else res[k].conflict.push(rec);
    }
  }
  return res;
}
function importPreviewHTML() {
  let html = '';
  if (S.ui.importErr.length) html += `<div class="err-box">${S.ui.importErr.map(esc).join('<br>')}</div>`;
  const pend = S.ui.pending;
  if (pend) {
    const plan = planMerge(pend);
    const demoOn = isDemoActive();
    html += `<div class="preview">
      <div>ফাইলে আছে: <b>${toBn(pend.people.length)}</b> জন ব্যক্তি, <b>${toBn(pend.txns.length)}</b> টি লেনদেন</div>
      <div class="muted">বর্তমান তথ্যের সাথে তুলনা: নতুন ${toBn(plan.people.add.length + plan.txns.add.length)} টি · অপরিবর্তিত ${toBn(plan.people.same + plan.txns.same)} টি · পার্থক্য ${toBn(plan.people.conflict.length + plan.txns.conflict.length)} টি</div>
      ${demoOn ? '<div class="notice">ডেমো ডেটা থাকলে মার্জ করা যাবে না।</div>' : ''}
      <button class="btn block" data-act="applyMerge" ${demoOn ? 'disabled' : ''}>মার্জ করে যোগ করুন</button>
      <button class="btn danger block" data-act="applyReplace">সব তথ্য এই ফাইল দিয়ে বদলান</button>
      <button class="btn ghost block" data-act="cancelImport">বাতিল করুন</button>
    </div>`;
  }
  return html;
}
async function applyImport(mode) {
  const imp = S.ui.pending;
  if (!imp) return;
  let people, txns;
  if (mode === 'replace') {
    if (!confirm('বর্তমান সব ব্যক্তি ও লেনদেন মুছে ফাইলের তথ্য বসবে। আগে বর্তমান তথ্যের ব্যাকআপ নিয়েছেন তো?')) return;
    people = imp.people;
    txns = imp.txns;
  } else {
    if (isDemoActive()) return toast('ডেমো ডেটা থাকলে মার্জ করা যাবে না। আগে সেটিংস থেকে মুছুন।', true);
    const plan = planMerge(imp);
    const nConf = plan.people.conflict.length + plan.txns.conflict.length;
    const overwrite = nConf > 0 && confirm(`${toBn(nConf)} টি রেকর্ড বর্তমান তথ্য থেকে আলাদা। ফাইলের সংস্করণ দিয়ে আপডেট করবেন?\n\nঠিক = আপডেট করুন\nবাতিল = বর্তমান তথ্য রাখুন`);
    const pm = new Map(S.people.map(x => [x.id, x]));
    const tm = new Map(S.txns.map(x => [x.id, x]));
    for (const r of plan.people.add) pm.set(r.id, HisabSync.touch({ ...r, sv: 0 }));
    for (const r of plan.txns.add) tm.set(r.id, HisabSync.touch({ ...r, sv: 0 }));
    if (overwrite) {
      for (const r of plan.people.conflict) pm.set(r.id, HisabSync.touch({ ...r, sv: (S.people.find(x => x.id === r.id) || {}).sv || 0 }));
      for (const r of plan.txns.conflict) tm.set(r.id, HisabSync.touch({ ...r, sv: (S.txns.find(x => x.id === r.id) || {}).sv || 0 }));
    }
    people = [...pm.values()];
    txns = [...tm.values()];
  }
  if (mode === 'replace' && window.Cloud && Cloud.isActive()) return Cloud.replaceEverywhere(people, txns);
  if (mode === 'replace') {
    people = people.map(p => HisabSync.touch({ ...p, sv: 0 }));
    txns = txns.map(t => HisabSync.touch({ ...t, sv: 0 }));
  }
  const pids = new Set(people.map(p => p.id));
  if (txns.some(t => !pids.has(t.personId))) { S.ui.importErr = ['কিছু লেনদেন কোনো ব্যক্তির সাথে যুক্ত নয়। ইমপোর্ট বাতিল।']; return render(); }
  for (const p of people) {
    const e = ledgerError(p.id, txns);
    if (e) { S.ui.importErr = [`${p.name}: ${e} ইমপোর্ট বাতিল।`]; return render(); }
  }
  await dbRun([
    { store: 'people', clear: true }, { store: 'txns', clear: true },
    ...people.map(p => ({ store: 'people', put: p })),
    ...txns.map(t => ({ store: 'txns', put: t })),
  ]);
  S.people = people;
  S.txns = txns;
  S.ui.pending = null;
  S.ui.importErr = [];
  toast(mode === 'replace' ? 'ফাইলের তথ্য দিয়ে বদলানো হয়েছে' : 'তথ্য মার্জ করা হয়েছে');
  if (window.Cloud) Cloud.changed();
  render();
  checkReminders().catch(() => {});
}

/* ---------- reminders (in-app list + browser notifications while the app runs) ---------- */
async function notify(title, body, tag) {
  const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
  if (reg) return reg.showNotification(title, { body, tag, icon: 'icon.svg', badge: 'icon.svg' });
  return new Notification(title, { body, tag, icon: 'icon.svg' });
}
const pruneNotified = obj => Object.fromEntries(Object.entries(obj)
  .filter(([k]) => !k.includes('|overdue|') || k.endsWith('|' + todayISO())));
async function checkReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const T = totals();
  const list = [...T.upcoming, ...(S.app.overdueAlert ? T.late : [])];
  const notified = { ...S.app.notified };
  let changed = false;
  for (const r of list) {
    const key = `${r.id}|${r.status}${r.status === 'overdue' ? '|' + todayISO() : ''}`;
    if (notified[key]) continue;
    notified[key] = true;
    changed = true;
    const title = r.status === 'overdue' ? 'মেয়াদোত্তীর্ণ পেমেন্ট' : 'আসন্ন পেমেন্ট';
    try { await notify(title, `${r.person.name} · ${TYPE_LABEL[r.type]} · ${fmt(r.remaining)} · ${fmtDate(r.dueDate)}`, key); }
    catch { /* notification blocked by OS: the in-app list still shows it */ }
  }
  if (changed) await saveApp({ notified: pruneNotified(notified) });
}

/* ---------- rendering & event wiring ---------- */
function renderTabs() {
  const cur = S.ui.personId ? 'people' : S.ui.tab;
  $('#tabbar').innerHTML = TABS.map(t => `<button data-act="tab" data-tab="${t.id}" ${cur === t.id ? 'aria-current="page"' : ''}>
    <svg viewBox="0 0 24 24" aria-hidden="true">${t.icon}</svg><span>${t.label}</span></button>`).join('');
}
function render() {
  if (!S.loaded) return;
  const views = { dash: viewDash, people: viewPeople, txns: viewTxns, backup: viewBackup, settings: viewSettings };
  const body = S.ui.personId ? viewPerson(S.ui.personId) : views[S.ui.tab]();
  $('#app').innerHTML = `<div class="wrap">${body}</div>`;
  renderTabs();
}

const acts = {
  tab: el => { S.ui.tab = el.dataset.tab; S.ui.personId = null; render(); window.scrollTo(0, 0); },
  person: el => { closeSheet(); S.ui.personId = el.dataset.id; render(); window.scrollTo(0, 0); },
  back: () => { S.ui.personId = null; render(); },
  close: () => closeSheet(),
  addPerson: () => { if (isDemoActive()) return toast(DEMO_BLOCK, true); openPersonForm(); },
  editPerson: el => openPersonForm(el.dataset.id),
  archive: el => toggleArchive(el.dataset.id),
  newTxn: el => (el.dataset.type
    ? openTxnForm({ type: el.dataset.type, personId: el.dataset.person || null })
    : openTypePicker()),
  txn: el => openTxnDetail(el.dataset.id),
  editTxn: el => openTxnForm({ id: el.dataset.id }),
  voidTxn: el => setVoided(el.dataset.id, true),
  restoreTxn: el => setVoided(el.dataset.id, false),
  chip: el => { S.ui[el.dataset.scope] = el.dataset.v; render(); },
  notifPerm: async () => {
    if (!('Notification' in window)) return toast('এই ব্রাউজারে নোটিফিকেশন সুবিধা নেই।', true);
    const r = await Notification.requestPermission();
    toast(r === 'granted' ? 'নোটিফিকেশন চালু হয়েছে' : 'নোটিফিকেশন অনুমতি দেওয়া হয়নি');
    render();
    checkReminders().catch(() => {});
  },
  exportJSON,
  applyMerge: () => applyImport('merge'),
  applyReplace: () => applyImport('replace'),
  cancelImport: () => { S.ui.pending = null; S.ui.importErr = []; render(); },
  demoLoad,
  demoClear,
  resetAll,
};
const forms = { person: savePerson, txn: saveTxn, settings: saveSettings };

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = acts[el.dataset.act];
  if (!act) return;
  e.preventDefault();
  Promise.resolve(act(el)).catch(err => toast('সমস্যা হয়েছে: ' + err.message, true));
});
document.addEventListener('submit', e => {
  e.preventDefault();
  const handler = forms[e.target.dataset.form];
  if (handler) Promise.resolve(handler(e.target)).catch(err => toast('সমস্যা হয়েছে: ' + err.message, true));
});
document.addEventListener('input', e => {
  if (e.target.id !== 'q') return;
  S.ui.q = e.target.value;
  const list = $('#plist');
  if (list) list.innerHTML = peopleList();
});
document.addEventListener('change', async e => {
  if (e.target.id !== 'importFile') return;
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  let obj = null;
  try { obj = JSON.parse(await file.text()); } catch { obj = null; }
  const result = validateBackup(obj);
  S.ui.importErr = result.errs;
  S.ui.pending = result.errs.length ? null : result;
  render();
});

/* ---------- boot ---------- */
(async function boot() {
  applyTheme();
  try {
    await load();
  } catch (err) {
    $('#app').innerHTML = `<div class="wrap"><div class="notice">ডেটাবেস খুলতে ব্যর্থ হয়েছে: ${esc(err.message)}। ব্রাউজারের স্টোরেজ সেটিংস দেখুন।</div></div>`;
    return;
  }
  window.dispatchEvent(new Event('hisab:loaded'));
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
  checkReminders().catch(() => {});
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkReminders().catch(() => {}); });
})();
