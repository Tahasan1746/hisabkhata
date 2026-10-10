/* হিসাবখাতা · WhatsApp Click-to-Chat core — pure logic, no DOM, no network, no paid service.
 * Opens https://wa.me/<digits>?text=<encoded> in the user's own WhatsApp. Nothing is sent automatically.
 * Shared by the browser (window.WhatsAppCore) and Node tests (module.exports). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WhatsAppCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
  const MAX_TEXT = 1000;   // keep the prefilled message comfortably short for wa.me

  /* ---------- number validation ---------- */
  // Accepts: 01XXXXXXXXX (11 digits), +8801XXXXXXXXX, 8801XXXXXXXXX, or another country as +<8-15 digits>.
  // Bangladeshi mobiles: 013–019 followed by 8 digits.
  function normalizePhone(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, error: 'WhatsApp নম্বর লিখুন।' };
    s = s.replace(/[০-৯]/g, d => String(BN_DIGITS.indexOf(d)));
    s = s.replace(/[\s\-().]/g, '');
    if (/[^\d+]/.test(s)) return { ok: false, error: 'নম্বরে শুধু সংখ্যা (০–৯) লিখুন। অক্ষর বা চিহ্ন বাদ দিন।' };
    if ((s.match(/\+/g) || []).length > 1 || (s.includes('+') && !s.startsWith('+'))) {
      return { ok: false, error: '+ চিহ্ন শুধু নম্বরের শুরুতে একবার লিখুন।' };
    }

    if (s.startsWith('+') && !s.startsWith('+880')) {
      const digits = s.slice(1);
      if (!/^\d{8,15}$/.test(digits)) return { ok: false, error: 'আন্তর্জাতিক নম্বর ৮–১৫ সংখ্যার হতে হবে (যেমন +14155550123)।' };
      return { ok: true, digits, e164: '+' + digits, country: 'other' };
    }

    let national = null;
    if (s.startsWith('+880')) national = s.slice(4);
    else if (s.startsWith('880') && s.length === 13) national = s.slice(3);
    else if (s.startsWith('01')) national = s.slice(1);
    if (national === null) {
      return { ok: false, error: 'বাংলাদেশের নম্বর 01 বা +880 দিয়ে শুরু হতে হবে (যেমন 01712345678 বা +8801712345678)।' };
    }
    if (national.length !== 10) {
      return { ok: false, error: 'বাংলাদেশের মোবাইল নম্বর ১১ সংখ্যার হতে হবে (যেমন 01712345678)।' };
    }
    if (!/^1[3-9]\d{8}$/.test(national)) {
      return { ok: false, error: 'বাংলাদেশের মোবাইল নম্বর 013 থেকে 019 দিয়ে শুরু হতে হবে।' };
    }
    const digits = '880' + national;
    return { ok: true, digits, e164: '+' + digits, country: 'BD' };
  }

  /* ---------- Click-to-Chat link ---------- */
  function waLink(digits, text) {
    if (!/^\d{8,15}$/.test(String(digits))) throw new Error('invalid WhatsApp number');
    return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(String(text));
  }

  /* ---------- Bengali messages built from record data ---------- */
  const bnNumber = n => new Intl.NumberFormat('bn-BD').format(n);
  function fmtTaka(paisa) {
    const v = Math.abs(Number(paisa) || 0) / 100;
    return '৳' + new Intl.NumberFormat('bn-BD', {
      minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(v);
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long', year: 'numeric' })
      .format(new Date(iso + 'T12:00:00+06:00'));
  }
  function paymentStatus(repaid, remaining) {
    if (remaining <= 0) return 'সম্পূর্ণ পরিশোধিত';
    if (repaid > 0) return 'আংশিক পরিশোধ';
    return 'এখনও পরিশোধ হয়নি';
  }
  function dueLine(status, days) {
    if (status === 'overdue') return `⚠️ নির্ধারিত তারিখ ${bnNumber(days)} দিন আগে পার হয়ে গেছে।`;
    if (status === 'today') return '⏰ আজই নির্ধারিত তারিখ।';
    if (status === 'upcoming') return `🗓 নির্ধারিত তারিখ আর ${bnNumber(days)} দিন বাকি।`;
    return '';
  }

  /*
   * d = {
   *   kind: 'reminder' | 'repay',         reminder = a loan that is due; repay = a repayment that was made or received
   *   name, loanType ('lent'|'borrowed'),  ('lent' = they owe me, 'borrowed' = I owe them)
   *   amount, repaid, remaining (paisa),   loan amount, repaid so far, still owed
   *   dueDate, status, days,               for reminders
   *   type ('received'|'paid'), date, balance   for repay messages (balance = total still owed in that direction)
   * }
   */
  function buildMessage(d) {
    const lines = [];
    const name = d.name || '';
    lines.push(`আসসালামু আলাইকুম ${name},`);

    if (d.kind === 'reminder') {
      if (d.loanType === 'lent') lines.push(`আপনার কাছে আমার ${fmtTaka(d.remaining)} পাওনা আছে।`);
      else lines.push(`আপনার কাছে আমার ${fmtTaka(d.remaining)} দেনা বাকি আছে।`);
      if (d.dueDate) lines.push(`নির্ধারিত তারিখ: ${fmtDate(d.dueDate)}`);
      const due = dueLine(d.status, d.days);
      if (due) lines.push(due);
      if (d.status === 'done') lines.push('এই হিসাব সম্পূর্ণ পরিশোধিত হয়েছে।');
      lines.push(`ধার: ${fmtTaka(d.amount)} · পরিশোধ: ${fmtTaka(d.repaid)} · বাকি: ${fmtTaka(d.remaining)}`);
      lines.push(`পরিশোধের অবস্থা: ${paymentStatus(d.repaid, d.remaining)}`);
      lines.push(d.loanType === 'lent'
        ? 'সুবিধামতো সময়ে পরিশোধ করবেন। ধন্যবাদ।'
        : 'নির্ধারিত সময়ের মধ্যে পরিশোধের চেষ্টা করছি, ইনশাআল্লাহ। ধন্যবাদ।');
    } else {
      if (d.type === 'received') lines.push(`${fmtDate(d.date)} তারিখে আমি আপনার কাছ থেকে ${fmtTaka(d.amount)} পেয়েছি।`);
      else lines.push(`${fmtDate(d.date)} তারিখে আমি আপনাকে ${fmtTaka(d.amount)} পরিশোধ করেছি।`);
      if (typeof d.balance === 'number') {
        lines.push(d.balance > 0 ? `এখনও বাকি আছে: ${fmtTaka(d.balance)}।` : 'এই হিসাব সম্পূর্ণ পরিশোধিত।');
      }
      lines.push('ধন্যবাদ।');
    }
    return lines.join('\n');
  }

  return { normalizePhone, waLink, buildMessage, fmtTaka, fmtDate, paymentStatus, MAX_TEXT };
});
