/* হিসাবখাতা · WhatsApp Click-to-Chat reminders (browser layer).
 * Rules:
 *  - WhatsApp only opens with the draft ready. The user presses Send in WhatsApp.
 *  - Opening WhatsApp never marks anything as sent.
 *  - A send is recorded only when the user explicitly confirms it (audit trail entry).
 *  - Uses the existing person.phone field and transaction.audit array. No schema change. */
(function () {
  'use strict';

  const Core = window.WhatsAppCore;
  const WA_ACTION = 'হোয়াটসঅ্যাপ';
  const DUE_STATES = ['upcoming', 'today', 'overdue'];

  function txnById(id) { return S.txns.find(t => t.id === id); }
  function personOf(t) { return S.people.find(p => p.id === t.personId) || { name: '', phone: '' }; }

  /* message data from the live ledger, so amounts and status always match the app */
  function reminderData(t) {
    const L = ledger(t.personId);
    const item = (L[t.type] && L[t.type].items || []).find(i => i.id === t.id);
    if (!item) return null;
    return {
      kind: 'reminder',
      name: personOf(t).name,
      loanType: t.type,
      amount: item.amount,
      repaid: item.repaid,
      remaining: item.remaining,
      dueDate: item.dueDate,
      status: item.status,
      days: item.dueDate ? Math.abs(dayDiff(item.dueDate, todayISO())) : 0,
    };
  }
  function repayData(t) {
    const L = ledger(t.personId);
    return {
      kind: 'repay',
      name: personOf(t).name,
      type: t.type,
      amount: t.amount,
      date: t.date,
      balance: t.type === 'received' ? L.lent.remaining : L.borrowed.remaining,
    };
  }
  function messageFor(t) {
    const d = REPAY_OF[t.type] ? repayData(t) : reminderData(t);
    return d ? Core.buildMessage(d) : '';
  }
  function defaultNumber(p) {
    const n = Core.normalizePhone(p.phone);
    return n.ok ? n.e164 : (p.phone || '');
  }
  function lastConfirmed(t) {
    return (t.audit || []).filter(a => a.action === WA_ACTION).pop();
  }

  /* ---------- the draft sheet ---------- */
  function openDraft(t) {
    const p = personOf(t);
    const kindLabel = REPAY_OF[t.type] ? TYPE_LABEL[t.type] : `${TYPE_LABEL[t.type]} · রিমাইন্ডার`;
    openSheet('হোয়াটসঅ্যাপ বার্তা', `
      <p class="muted">${esc(p.name)} · ${esc(kindLabel)}</p>
      ${field('WhatsApp নম্বর (01 দিয়ে বা +880 দিয়ে)',
        `<input id="wa-number" type="tel" inputmode="tel" value="${esc(defaultNumber(p))}" placeholder="01XXXXXXXXX বা +8801XXXXXXXXX">`)}
      ${field('বার্তা (দরকার হলে বদলাতে পারেন)',
        `<textarea id="wa-text" rows="10" maxlength="${Core.MAX_TEXT}">${esc(messageFor(t))}</textarea>`)}
      <div class="err" id="wa-err" hidden></div>
      <button class="btn block" data-act="waOpenNow" data-id="${t.id}">WhatsApp-এ বার্তা খুলুন</button>
      <div class="stack" style="margin-top:10px">
        <button class="btn ghost block" data-act="waSaveNumber" data-id="${t.id}">এই নম্বরটি সংরক্ষণ করুন</button>
        <button class="btn ghost block" data-act="waConfirmSent" data-id="${t.id}">আমি বার্তাটি নিজে পাঠিয়েছি</button>
      </div>
      <p class="muted">WhatsApp খুললেই বার্তা পাঠানো হয় না। WhatsApp-এ নিজে Send চাপুন। পাঠানোর পরে এখানে নিশ্চিত করুন।</p>`);
  }

  /* ---------- acts ---------- */
  function waTxn(el) {
    const t = txnById(el.dataset.id);
    if (!t || t.voided) return toast('এই লেনদেনে বার্তা তৈরি করা যাবে না', true);
    openDraft(t);
  }

  function showErr(msg) {
    const box = $('#wa-err');
    if (!box) return toast(msg, true);
    box.textContent = msg;
    box.hidden = false;
  }

  function waOpenNow(el) {
    const n = Core.normalizePhone($('#wa-number') && $('#wa-number').value);
    if (!n.ok) return showErr(n.error);
    const text = ($('#wa-text') && $('#wa-text').value || '').trim();
    if (!text) return showErr('বার্তা খালি রাখা যাবে না।');
    if (text.length > Core.MAX_TEXT) return showErr(`বার্তা ${Core.MAX_TEXT} অক্ষরের মধ্যে রাখুন।`);
    const box = $('#wa-err');
    if (box) box.hidden = true;
    // user gesture: opens WhatsApp with the draft. Nothing is recorded here.
    window.open(Core.waLink(n.digits, text), '_blank', 'noopener');
    toast('WhatsApp খোলা হয়েছে। বার্তাটি নিজে Send করুন।');
  }

  async function waSaveNumber(el) {
    const t = txnById(el.dataset.id);
    if (!t) return;
    const person = S.people.find(p => p.id === t.personId);
    if (!person) return;
    const n = Core.normalizePhone($('#wa-number') && $('#wa-number').value);
    if (!n.ok) return showErr(n.error);
    const rec = HisabSync.touch({ ...person, phone: n.e164, updatedAt: nowIso() });
    await dbRun([{ store: 'people', put: rec }]);
    S.people = S.people.map(p => (p.id === rec.id ? rec : p));
    if ($('#wa-number')) $('#wa-number').value = n.e164;
    const box = $('#wa-err');
    if (box) box.hidden = true;
    toast('নম্বর সংরক্ষিত হয়েছে');
    if (window.Cloud) Cloud.changed();
  }

  async function waConfirmSent(el) {
    const t = txnById(el.dataset.id);
    if (!t || t.voided) return toast('এই লেনদেনে নিশ্চিত করা যাবে না', true);
    if (!window.confirm('আপনি কি নিশ্চিত যে বার্তাটি WhatsApp-এ নিজে পাঠিয়েছেন?')) return;
    const rec = HisabSync.touch({ ...t });
    audit(rec, WA_ACTION, 'ব্যবহারকারী নিশ্চিত করেছেন: বার্তা নিজে পাঠানো হয়েছে');
    await dbRun([{ store: 'txns', put: rec }]);
    S.txns = S.txns.map(x => (x.id === rec.id ? rec : x));
    toast('পাঠানো হিসেবে নিশ্চিত করা হয়েছে');
    render();
    openTxnDetail(rec.id);
    if (window.Cloud) Cloud.changed();
  }

  Object.assign(acts, { waTxn, waOpenNow, waSaveNumber, waConfirmSent });

  /* ---------- markup helpers used by app.js screens ---------- */
  // a reminder button for upcoming, today or overdue loans; empty string otherwise
  function rowButton(id, status, remaining) {
    if (!DUE_STATES.includes(status) || !(remaining > 0)) return '';
    return `<button class="wa-btn" data-act="waTxn" data-id="${id}" aria-label="হোয়াটসঅ্যাপে রিমাইন্ডার পাঠান">WhatsApp</button>`;
  }
  // the section shown in the transaction details sheet
  function sectionHTML(t) {
    if (t.voided) return '';
    const last = lastConfirmed(t);
    return `<h2>হোয়াটসঅ্যাপ</h2>
      <button class="btn block" data-act="waTxn" data-id="${t.id}">হোয়াটসঅ্যাপে বার্তা তৈরি করুন</button>
      <p class="muted">${last
        ? `শেষ নিশ্চিত পাঠানো: ${fmtDT(last.at)}`
        : 'এখনও কোনো বার্তা নিশ্চিত করা হয়নি।'}</p>`;
  }

  window.WA = { rowButton, sectionHTML };
})();
