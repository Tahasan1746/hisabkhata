/* হিসাবখাতা · sync core — pure logic, no DOM, no network.
 * Shared by the browser (window.HisabSync) and the Node tests (module.exports).
 * Remote calls are injected via env.push / env.pull, so the engine is testable offline.
 *
 * Record fields added for sync (local only, never sent as-is):
 *   sv        last server version this device has seen (0 = never synced)
 *   dirty     has a local change that the server has not confirmed
 *   rev       counter bumped on every local change (lets us detect edits made during a sync)
 *   conflict  waiting for the user to choose a version
 *   needsRefresh  a discarded local change; re-fetch the cloud copy on next pull
 * sync state (stored in S.app.sync): { ownerId, cursor, tombs, conflicts, lastSyncedAt, lastCloudBackupAt }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HisabSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const EPOCH = '1970-01-01T00:00:00.000Z';
  const OVERLAP_MS = 2 * 60 * 1000;   // re-read a small window so late-committed rows are not missed
  const BATCH = 100;
  const REPAY_OF = { received: 'lent', paid: 'borrowed' };

  /* ---------- key safety: the browser may only hold the public anon/publishable key ---------- */
  function jwtRole(key) {
    const parts = String(key).split('.');
    if (parts.length !== 3) return null;
    try {
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      return JSON.parse(atob(b64)).role || null;
    } catch (e) {
      return null;
    }
  }
  function isSecretKey(key) {
    const k = String(key || '');
    return k.startsWith('sb_secret_') || jwtRole(k) === 'service_role';
  }
  function assertPublicKey(key) {
    if (!key) throw new Error('anon/publishable কী পাওয়া যায়নি।');
    if (isSecretKey(key)) {
      throw new Error('সার্ভিস-রোল বা সিক্রেট কী ক্লায়েন্টে ব্যবহার করা যাবে না। শুধু public anon/publishable কী বসান।');
    }
    return true;
  }

  function isNetworkError(err, nav) {
    if (nav && nav.onLine === false) return true;
    if (err instanceof TypeError) return true;
    return /fetch|network|failed to|load failed/i.test(String((err && err.message) || ''));
  }

  /* ---------- mapping: local (camelCase, paisa) <-> cloud (snake_case) ---------- */
  function toCloudPerson(p) {
    return {
      id: p.id, name: p.name, phone: p.phone || '', notes: p.notes || '',
      archived: !!p.archived, created_at: p.createdAt || new Date().toISOString(),
    };
  }
  function fromCloudPerson(r) {
    return {
      id: r.id, name: r.name, phone: r.phone || '', notes: r.notes || '', archived: !!r.archived,
      createdAt: r.created_at, updatedAt: r.updated_at, sv: r.version, dirty: false, rev: 0,
    };
  }
  function toCloudTxn(t) {
    return {
      id: t.id, person_id: t.personId, type: t.type, amount_paisa: t.amount, txn_date: t.date,
      due_date: t.dueDate || null, category: t.category || 'অন্যান্য', note: t.note || '',
      voided: !!t.voided, audit: Array.isArray(t.audit) ? t.audit : [],
      created_at: t.createdAt || new Date().toISOString(),
    };
  }
  function fromCloudTxn(r) {
    return {
      id: r.id, personId: r.person_id, type: r.type, amount: Number(r.amount_paisa), date: r.txn_date,
      dueDate: r.due_date || null, category: r.category, note: r.note || '', voided: !!r.voided,
      audit: Array.isArray(r.audit) ? r.audit : [], createdAt: r.created_at, updatedAt: r.updated_at,
      sv: r.version, dirty: false, rev: 0,
    };
  }

  /* ---------- local change bookkeeping ---------- */
  function touch(rec) {
    rec.dirty = true;
    rec.rev = (rec.rev || 0) + 1;
    return rec;
  }
  function emptySync(s) {
    s = s || {};
    return {
      ownerId: s.ownerId || null, cursor: s.cursor || null,
      tombs: s.tombs || [], conflicts: s.conflicts || [],
      lastSyncedAt: s.lastSyncedAt || null, lastCloudBackupAt: s.lastCloudBackupAt || null,
    };
  }
  /* Records written before sync existed get sv=0 and are queued for upload (demo data is never uploaded). */
  function ensureSyncFields(list) {
    return list.map(r => (r.sv === undefined
      ? { ...r, sv: 0, dirty: !r.demo, rev: r.rev || 1 }
      : r));
  }
  /* When the user resets everything locally, every record the cloud knows about becomes a tombstone. */
  function tombsForReset(people, txns, sync) {
    const s = emptySync(sync);
    const tombs = [...s.tombs];
    const add = (kind, list) => {
      for (const r of list) {
        if (r.demo || !(r.sv > 0)) continue;
        if (tombs.some(t => t.kind === kind && t.id === r.id)) continue;
        tombs.push({ kind, id: r.id, type: kind === 'txn' ? r.type : null, sv: r.sv, conflict: false });
      }
    };
    add('person', people);
    add('txn', txns);
    return { ...s, tombs };
  }

  const keyOf = (kind, id) => kind + ':' + id;
  function pushConflict(list, c) {
    const i = list.findIndex(x => x.key === c.key);
    if (i >= 0) list[i] = c; else list.push(c);
  }
  function countPending(st) {
    const sync = emptySync(st.sync);
    const p = st.people.filter(r => r.dirty && !r.demo && !r.conflict).length;
    const t = st.txns.filter(r => r.dirty && !r.demo && !r.conflict).length;
    const tb = sync.tombs.filter(x => !x.conflict).length;
    return p + t + tb;
  }

  /* ---------- build the push batch ---------- */
  // Order matters for foreign keys and the ledger rule:
  // people upserts -> loan upserts -> repayment upserts -> repayment deletes -> loan deletes -> person deletes
  const RANK = c => {
    if (c.kind === 'person') return c.op === 'delete' ? 5 : 0;
    const repay = !!REPAY_OF[c.type];
    if (c.op === 'delete') return repay ? 3 : 4;
    return repay ? 2 : 1;
  };
  function buildChanges(st) {
    const sync = emptySync(st.sync);
    const out = [];
    for (const p of st.people) {
      if (p.dirty && !p.demo && !p.conflict) {
        out.push({ kind: 'person', id: p.id, op: 'upsert', expected: p.sv || 0, rev: p.rev || 0, data: toCloudPerson(p) });
      }
    }
    for (const t of st.txns) {
      if (t.dirty && !t.demo && !t.conflict) {
        out.push({ kind: 'txn', id: t.id, type: t.type, op: 'upsert', expected: t.sv || 0, rev: t.rev || 0, data: toCloudTxn(t) });
      }
    }
    for (const tb of sync.tombs) {
      if (!tb.conflict) out.push({ kind: tb.kind, id: tb.id, type: tb.type, op: 'delete', expected: tb.sv || 0, rev: 0 });
    }
    return out.sort((a, b) => RANK(a) - RANK(b));
  }

  /* ---------- apply push results ---------- */
  // results: [{kind,id,status:'ok',version} | {kind,id,status:'conflict',server} | {kind,id,status:'error',message}]
  function applyPushResults(st, changes, results) {
    const byKey = new Map((results || []).map(r => [keyOf(r.kind, r.id), r]));
    const people = st.people.slice();
    const txns = st.txns.slice();
    const sync = emptySync(st.sync);
    const tombs = sync.tombs.slice();
    const conflicts = sync.conflicts.slice();
    const at = new Date().toISOString();
    let okCount = 0;

    for (const ch of changes) {
      const key = keyOf(ch.kind, ch.id);
      const r = byKey.get(key);
      if (!r) continue;                                  // no answer for this change: it stays dirty

      if (ch.op === 'delete') {
        const ti = tombs.findIndex(tb => tb.kind === ch.kind && tb.id === ch.id);
        if (r.status === 'ok') {
          okCount++;
          if (ti >= 0) tombs.splice(ti, 1);
        } else {
          if (ti >= 0) tombs[ti] = { ...tombs[ti], conflict: true };
          pushConflict(conflicts, { key, kind: ch.kind, id: ch.id, op: 'delete',
            reason: r.status === 'conflict' ? 'remote-changed' : 'rejected',
            server: r.server || null, message: r.message || '', at });
        }
        continue;
      }

      const list = ch.kind === 'person' ? people : txns;
      const i = list.findIndex(x => x.id === ch.id);
      if (i < 0) continue;                               // deleted locally while the request was running
      if (r.status === 'ok') {
        okCount++;
        const cur = list[i];
        const stillSame = (cur.rev || 0) === ch.rev;     // no edit landed during the request
        list[i] = { ...cur, sv: r.version, dirty: !stillSame, conflict: false };
        const ci = conflicts.findIndex(c => c.key === key);
        if (ci >= 0) conflicts.splice(ci, 1);
      } else {
        list[i] = { ...list[i], conflict: true };
        pushConflict(conflicts, { key, kind: ch.kind, id: ch.id, op: 'upsert',
          reason: r.status === 'conflict' ? 'remote-changed' : 'rejected',
          server: r.server || null, message: r.message || '', at });
      }
    }
    return { people, txns, sync: { ...sync, tombs, conflicts }, okCount };
  }

  /* ---------- merge a pull into local state ---------- */
  function mergeSide(list, rows, kind, mapper, tombs, conflicts) {
    const byId = new Map(list.map(x => [x.id, x]));
    const at = new Date().toISOString();
    for (const row of rows || []) {
      const deleted = !!row.deleted_at;
      const key = keyOf(kind, row.id);
      const cur = byId.get(row.id);

      if (!cur) {
        const ti = tombs.findIndex(t => t.kind === kind && t.id === row.id);
        if (ti >= 0) {                                    // we deleted it here; did the cloud change it since?
          const tb = tombs[ti];
          if (!deleted && (row.version || 0) > (tb.sv || 0)) {
            tombs[ti] = { ...tb, conflict: true };
            pushConflict(conflicts, { key, kind, id: row.id, op: 'delete', reason: 'remote-changed', server: row, message: '', at });
          }
          continue;
        }
        if (!deleted) byId.set(row.id, mapper(row));
        continue;
      }

      if (cur.needsRefresh) {                             // discarded local change: take the cloud copy
        if (deleted) byId.delete(row.id); else byId.set(row.id, mapper(row));
        continue;
      }

      if (cur.dirty || cur.conflict) {
        if ((row.version || 0) > (cur.sv || 0)) {         // someone else changed it after our last sync
          byId.set(row.id, { ...cur, conflict: true });
          pushConflict(conflicts, { key, kind, id: row.id, op: 'upsert', reason: 'remote-changed', server: row, message: '', at });
        }
        continue;                                         // our pending change wins until the user decides
      }

      if ((row.version || 0) > (cur.sv || 0)) {
        if (deleted) byId.delete(row.id); else byId.set(row.id, mapper(row));
      }
    }
    return [...byId.values()];
  }
  function applyPull(st, pulled) {
    const sync = emptySync(st.sync);
    const tombs = sync.tombs.slice();
    const conflicts = sync.conflicts.slice();
    const people = mergeSide(st.people, pulled.people, 'person', fromCloudPerson, tombs, conflicts);
    const txns = mergeSide(st.txns, pulled.txns, 'txn', fromCloudTxn, tombs, conflicts);
    return { people, txns, sync: { ...sync, tombs, conflicts } };
  }

  /* ---------- user decisions for conflicts ---------- */
  // choice 'local'  = keep my version (re-send it against the server's current version)
  // choice 'server' = take the cloud version (or discard my unsent change if the cloud has no copy)
  function resolveConflict(st, key, choice) {
    const sync = emptySync(st.sync);
    const c = sync.conflicts.find(x => x.key === key);
    if (!c) return { people: st.people, txns: st.txns, sync };

    const people = st.people.slice();
    const txns = st.txns.slice();
    const tombs = sync.tombs.slice();
    const target = c.kind === 'person' ? people : txns;
    const mapper = c.kind === 'person' ? fromCloudPerson : fromCloudTxn;
    const idx = target.findIndex(r => r.id === c.id);
    const ti = tombs.findIndex(t => t.kind === c.kind && t.id === c.id);

    if (c.op === 'delete') {
      if (choice === 'local') {
        if (ti >= 0) tombs[ti] = { ...tombs[ti], sv: c.server ? c.server.version : tombs[ti].sv, conflict: false };
      } else {
        if (ti >= 0) tombs.splice(ti, 1);
        if (c.server && !c.server.deleted_at && idx < 0) target.push(mapper(c.server));
      }
    } else if (idx >= 0) {
      const cur = target[idx];
      if (choice === 'local') {
        target[idx] = {
          ...cur, sv: c.server ? c.server.version : cur.sv,
          dirty: true, conflict: false, rev: (cur.rev || 0) + 1,
        };
      } else if (c.server && c.server.deleted_at) {
        target.splice(idx, 1);
      } else if (c.server) {
        target[idx] = mapper(c.server);
      } else if ((cur.sv || 0) === 0) {
        target.splice(idx, 1);                             // never reached the cloud: discarding it is complete
      } else {
        target[idx] = { ...cur, dirty: false, conflict: false, needsRefresh: true };
      }
    }
    return { people, txns, sync: { ...sync, tombs, conflicts: sync.conflicts.filter(x => x.key !== key) } };
  }

  /* ---------- one full sync run ---------- */
  // env: { getState(): {people,txns,sync}, commit(state): Promise, push(changes): Promise<results>, pull(since): Promise<{people,txns,server_time}> }
  async function runSync(env) {
    let st = env.getState();
    let pushed = 0;
    const changes = buildChanges(st);
    for (let i = 0; i < changes.length; i += BATCH) {
      const chunk = changes.slice(i, i + BATCH);
      const results = await env.push(chunk);
      st = env.getState();                                 // fresh copy: the user may have edited during the request
      const next = applyPushResults(st, chunk, results);
      pushed += next.okCount;
      st = { people: next.people, txns: next.txns, sync: next.sync };
      await env.commit(st);
    }

    const forceFull = st.people.concat(st.txns).some(r => r.needsRefresh);
    const since = !forceFull && st.sync.cursor ? st.sync.cursor : EPOCH;
    const pulled = await env.pull(since);
    st = env.getState();
    st = applyPull(st, pulled);
    const serverMs = Date.parse(pulled.server_time) || Date.now();
    st = {
      ...st,
      sync: {
        ...st.sync,
        cursor: new Date(serverMs - OVERLAP_MS).toISOString(),
        lastSyncedAt: new Date().toISOString(),
      },
    };
    await env.commit(st);
    return { pushed, conflicts: st.sync.conflicts.length, pending: countPending(st) };
  }

  /* ---------- replace-all result (restore / import with cloud on) ---------- */
  function stateAfterReplace(people, txns, versions, serverTime, prevSync) {
    const pv = new Map((versions.people || []).map(v => [v.id, v.version]));
    const tv = new Map((versions.txns || []).map(v => [v.id, v.version]));
    const clean = (r, m) => ({ ...r, sv: m.get(r.id) || 0, dirty: false, conflict: false, rev: 0 });
    return {
      people: people.map(p => clean(p, pv)),
      txns: txns.map(t => clean(t, tv)),
      sync: emptySync({
        ...emptySync(prevSync),
        tombs: [], conflicts: [],
        cursor: new Date(Date.parse(serverTime) - OVERLAP_MS).toISOString(),
        lastSyncedAt: new Date().toISOString(),
      }),
    };
  }

  /* ---------- backup payload, canonical JSON, checksum ---------- */
  function buildPayload(people, txns, exportedAt) {
    const plain = o => {
      const c = { ...o };
      for (const k of ['demo', 'dirty', 'sv', 'rev', 'conflict', 'needsRefresh']) delete c[k];
      return c;
    };
    return {
      app: 'hisabkhata', version: 1, exportedAt,
      people: people.filter(p => !p.demo).map(plain),
      txns: txns.filter(t => !t.demo).map(plain),
    };
  }
  function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  async function sha256Hex(text) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const checksumOf = payload => sha256Hex(canonical(payload));

  return {
    EPOCH, OVERLAP_MS, BATCH,
    isSecretKey, assertPublicKey, isNetworkError,
    toCloudPerson, fromCloudPerson, toCloudTxn, fromCloudTxn,
    touch, emptySync, ensureSyncFields, tombsForReset, countPending,
    buildChanges, applyPushResults, applyPull, resolveConflict, runSync, stateAfterReplace,
    buildPayload, canonical, sha256Hex, checksumOf,
  };
});
