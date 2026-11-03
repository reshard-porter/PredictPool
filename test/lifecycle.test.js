'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const recon = require('../src/services/reconciliation');

test.before(H.reset);
test.after(H.closePool);
const SYS = { type: 'SYSTEM', id: null };

test('late entry is rejected by server time even while status still says OPEN', async () => {
  const u = await H.makeUser(5000);
  const P = await H.makePool({ deadlineMs: 1500 });
  await H.enter(await H.makeUser(1000), P, 'HOME');            // on time
  await new Promise((r) => setTimeout(r, 1700));
  const { rows: [p] } = await H.getPool().query('SELECT status FROM pools WHERE id=$1', [P.pool.id]);
  assert.equal(p.status, 'OPEN');                              // lock job has not run yet
  await assert.rejects(H.enter(u, P, 'HOME'), (e) => e.code === 'ENTRY_DEADLINE_PASSED');
  assert.equal((await H.bal(u.id)).availableMinor, 5000);
  await H.pools.lockDuePools();
  const { rows: [p2] } = await H.getPool().query('SELECT status FROM pools WHERE id=$1', [P.pool.id]);
  assert.equal(p2.status, 'LOCKED');
});

test('entry requires the exact accepted terms version', async () => {
  const u = await H.makeUser(1000);
  const P = await H.makePool();
  await assert.rejects(H.entries.enter(u.id, P.pool.id, { selectionId: P.sel.HOME, acceptedRulesVersion: 'refundable-v1.0', acceptedTermsHash: 'stale' }),
    (e) => e.code === 'TERMS_CHANGED');
});

test('payout: matches the documented worked example end to end', async () => {
  const P = await H.makePool({ entry: 1000, feeBps: 500, prize: 10000 });
  const picks = ['HOME', 'AWAY', 'HOME', 'AWAY', 'HOME', 'AWAY', 'AWAY'];
  const us = [];
  for (const pk of picks) { const u = await H.makeUser(1000); await H.enter(u, P, pk); us.push([u, pk]); }
  await H.finish(P, { outcomeType: 'WINNER', winningCode: 'HOME' });
  const r = await H.settlement.execute(SYS, P.pool.id);
  assert.equal(r.status, 'SETTLED');
  for (const [u, pk] of us) {
    const b = await H.bal(u.id);
    assert.equal(b.availableMinor, pk === 'HOME' ? 950 + 3333 : 950);
    assert.equal(b.lockedMinor, 0);
  }
  assert.equal(await H.accountTotal('FEE_REVENUE'), 350);
  assert.equal(await H.accountTotal('POOL_PRIZE_ESCROW', P.pool.id), 0);
  const st = await H.settlement.statement(us[0][0].id, (await H.entries.myEntries(us[0][0].id))[0].entryId);
  assert.equal(st.items.find((i) => i.total).amountMinor, 4283);
  const inv = await recon.invariants();
  assert.ok(inv.ok, JSON.stringify(inv.checks.filter((c) => !c.ok)));
});

test('cancellation: full deposit refund, no fee, prize back to sponsor', async () => {
  const P = await H.makePool({ prize: 7777 });
  const u1 = await H.makeUser(1000); const u2 = await H.makeUser(1000);
  await H.enter(u1, P, 'HOME'); await H.enter(u2, P, 'AWAY');
  const feesBefore = await H.accountTotal('FEE_REVENUE');
  await H.pools.cancelPool({ type: 'ADMIN', id: H.ctx.admin.id }, P.pool.id, 'Event cancelled by organiser');
  const r = await H.settlement.execute(SYS, P.pool.id);
  assert.equal(r.status, 'REFUNDED');
  for (const u of [u1, u2]) assert.deepEqual([(await H.bal(u.id)).availableMinor, (await H.bal(u.id)).lockedMinor], [1000, 0]);
  assert.equal(await H.accountTotal('FEE_REVENUE'), feesBefore);
  assert.equal(await H.accountTotal('POOL_PRIZE_ESCROW', P.pool.id), 0);
});

test('no correct predictions: everyone refunded in full with no fee', async () => {
  const P = await H.makePool({ selections: ['HOME', 'AWAY', 'DRAW'] });
  const us = [await H.makeUser(1000), await H.makeUser(1000)];
  await H.enter(us[0], P, 'HOME'); await H.enter(us[1], P, 'HOME');
  await H.finish(P, { outcomeType: 'WINNER', winningCode: 'AWAY' });
  const r = await H.settlement.execute(SYS, P.pool.id);
  assert.equal(r.status, 'REFUNDED');
  assert.equal(r.totals.feesMinor, 0);
  for (const u of us) assert.equal((await H.bal(u.id)).availableMinor, 1000);
});

test('unsupported tie: full refund, no fee', async () => {
  const P = await H.makePool();
  const u = await H.makeUser(1000); await H.enter(u, P, 'HOME');
  await H.finish(P, { outcomeType: 'TIE' });
  const r = await H.settlement.execute(SYS, P.pool.id);
  assert.equal(r.status, 'REFUNDED');
  assert.equal((await H.bal(u.id)).availableMinor, 1000);
});

test('disputed results are held before settlement; correction before settlement replaces result', async () => {
  const P = await H.makePool();
  const a = await H.makeUser(1000); const b = await H.makeUser(1000);
  await H.enter(a, P, 'HOME'); await H.enter(b, P, 'AWAY');
  await H.finish(P, { outcomeType: 'WINNER', winningCode: 'HOME' });
  const d = await H.results.raiseDispute({ type: 'USER', id: b.id }, P.pool.id, 'Home goal was offside per official review');
  await assert.rejects(H.settlement.execute(SYS, P.pool.id), (e) => e.code === 'DISPUTE_OPEN');
  // Official source publishes a correction; dispute upheld.
  await H.results.recordResult(H.ctx.admin, P.event.id, { source: P.event.official_source, sourceRef: 'correction', outcomeType: 'WINNER', winningCode: 'AWAY', isFinal: true });
  await assert.rejects(H.results.confirmResult(H.ctx.admin, P.pool.id), (e) => e.code === 'DISPUTE_OPEN' || e.code === 'INVALID_STATE');
  await H.results.resolveDispute(H.ctx.admin, d.id, { decision: 'UPHELD', note: 'Official correction v2' });
  await H.results.confirmResult(H.ctx.admin, P.pool.id);
  await H.settlement.execute(SYS, P.pool.id);
  assert.equal((await H.bal(b.id)).availableMinor, 950 + 10000);
  assert.equal((await H.bal(a.id)).availableMinor, 950);
  // A correction after settlement is recorded but never reverses money.
  await H.results.recordResult(H.ctx.admin, P.event.id, { source: P.event.official_source, sourceRef: 'late', outcomeType: 'WINNER', winningCode: 'HOME', isFinal: true });
  assert.equal((await H.bal(b.id)).availableMinor, 10950);
});

test('results from an undocumented source are refused', async () => {
  const P = await H.makePool();
  await assert.rejects(H.results.recordResult(H.ctx.admin, P.event.id, { source: 'Some blog', outcomeType: 'WINNER', winningCode: 'HOME' }),
    (e) => e.code === 'UNOFFICIAL_SOURCE');
});

test('postponement: within window stays valid, beyond window cancels with refunds', async () => {
  const P1 = await H.makePool();
  const ok = await H.pools.postponeEvent(H.ctx.admin, P1.event.id, new Date(new Date(P1.event.starts_at).getTime() + 24 * 3.6e6).toISOString());
  assert.equal(ok[0].action, 'REMAINS_VALID');
  const P2 = await H.makePool();
  const u = await H.makeUser(1000); await H.enter(u, P2, 'HOME');
  const out = await H.pools.postponeEvent(H.ctx.admin, P2.event.id, new Date(new Date(P2.event.starts_at).getTime() + 100 * 3.6e6).toISOString());
  assert.equal(out[0].action, 'CANCELLED_FULL_REFUND');
  await H.settlement.execute(SYS, P2.pool.id);
  assert.equal((await H.bal(u.id)).availableMinor, 1000);
});
