'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const recon = require('../src/services/reconciliation');
const outbox = require('../src/outbox');
const worker = require('../src/worker');

test.before(H.reset);
test.after(H.closePool);
const SYS = { type: 'SYSTEM', id: null };

async function populated(n = 6) {
  const P = await H.makePool({ prize: 10000 });
  const us = [];
  for (let i = 0; i < n; i++) { const u = await H.makeUser(1000); await H.enter(u, P, i % 2 ? 'AWAY' : 'HOME'); us.push(u); }
  await H.finish(P, { outcomeType: 'WINNER', winningCode: 'HOME' });
  return { P, us };
}

test('settlement crash mid-way, then retry: completes once, no duplicate credits', async () => {
  const { P, us } = await populated(6);
  await assert.rejects(H.settlement.execute(SYS, P.pool.id, { failAfterLines: 2 }), /SIMULATED_CRASH/);
  const { rows: [half] } = await H.getPool().query('SELECT count(*)::int n FROM settlement_lines WHERE pool_id=$1 AND ledger_txn_id IS NOT NULL', [P.pool.id]);
  assert.equal(half.n, 2);
  const r = await H.settlement.execute(SYS, P.pool.id);
  assert.equal(r.status, 'SETTLED');
  const again = await H.settlement.execute(SYS, P.pool.id);
  assert.equal(again.status, 'already_completed');
  const total = (await Promise.all(us.map((u) => H.bal(u.id)))).reduce((s, b) => s + b.availableMinor, 0);
  assert.equal(total, 6 * 950 + 3 * 3333);
  const { rows: [{ n }] } = await H.getPool().query(`SELECT count(*)::int n FROM ledger_transactions WHERE pool_id=$1 AND type LIKE 'SETTLEMENT%'`, [P.pool.id]);
  assert.equal(n, 6);
  const { rows: [run] } = await H.getPool().query('SELECT attempts FROM settlement_runs WHERE pool_id=$1', [P.pool.id]);
  assert.ok(run.attempts >= 2);
});

test('concurrent settlement executions do not double-pay', async () => {
  const { P, us } = await populated(5);
  const rs = await Promise.allSettled(Array.from({ length: 4 }, () => H.settlement.execute(SYS, P.pool.id)));
  assert.ok(rs.some((r) => r.status === 'fulfilled'));
  await H.settlement.execute(SYS, P.pool.id).catch(() => {});      // ensure completion
  const total = (await Promise.all(us.map((u) => H.bal(u.id)))).reduce((s, b) => s + b.availableMinor, 0);
  assert.equal(total, 5 * 950 + 10000 - 1);                         // 3 winners → 3333 × 3, 1 unit to sponsor
  const inv = await recon.invariants();
  assert.ok(inv.ok, JSON.stringify(inv.checks.filter((c) => !c.ok)));
});

test('settlement request via outbox is de-duplicated and retried by the worker', async () => {
  const { P } = await populated(4);
  await H.settlement.requestSettlement(H.ctx.admin, P.pool.id);
  await H.settlement.requestSettlement(H.ctx.admin, P.pool.id);     // double click
  const { rows: [{ n }] } = await H.getPool().query(`SELECT count(*)::int n FROM outbox WHERE dedupe_key=$1`, [`settle:${P.pool.id}`]);
  assert.equal(n, 1);
  // First worker attempt fails (handler crash), second succeeds.
  let first = true;
  const flaky = { ...worker.handlers, 'settlement.execute': async (p) => {
    if (first) { first = false; throw new Error('worker crashed'); }
    return worker.handlers['settlement.execute'](p);
  } };
  const drain = async () => { while (await outbox.runOnce(flaky) > 0); };
  await drain();
  const { rows: [m] } = await H.getPool().query(`SELECT status, attempts, last_error FROM outbox WHERE dedupe_key=$1`, [`settle:${P.pool.id}`]);
  assert.deepEqual([m.status, m.attempts, m.last_error], ['PENDING', 1, 'worker crashed']);
  await H.getPool().query(`UPDATE outbox SET available_at=now() WHERE dedupe_key=$1`, [`settle:${P.pool.id}`]); // skip backoff
  await drain();
  const { rows: [p] } = await H.getPool().query('SELECT status FROM pools WHERE id=$1', [P.pool.id]);
  assert.equal(p.status, 'SETTLED');
});
