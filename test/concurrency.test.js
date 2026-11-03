'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const withdrawals = require('../src/services/withdrawals');

test.before(H.reset);
test.after(H.closePool);

const settle = (ps) => Promise.allSettled(ps).then((rs) => ({ ok: rs.filter((r) => r.status === 'fulfilled'), bad: rs.filter((r) => r.status === 'rejected') }));

test('concurrent spending: one deposit cannot fund two pools at once', async () => {
  const u = await H.makeUser(1000);
  const pools = await Promise.all([1, 2, 3, 4, 5].map(() => H.makePool({ entry: 1000 })));
  const r = await settle(pools.map((P) => H.enter(u, P, 'HOME')));
  assert.equal(r.ok.length, 1);
  assert.ok(r.bad.every((x) => x.reason.code === 'INSUFFICIENT_FUNDS'));
  const b = await H.bal(u.id);
  assert.deepEqual([b.availableMinor, b.lockedMinor], [0, 1000]);
});

test('concurrent duplicate entries into the same pool: exactly one accepted', async () => {
  const u = await H.makeUser(10000);
  const P = await H.makePool();
  const r = await settle(Array.from({ length: 10 }, () => H.enter(u, P, 'AWAY')));
  assert.equal(r.ok.length, 1);
  assert.equal((await H.bal(u.id)).lockedMinor, 1000);
});

test('concurrent withdrawals cannot overdraw', async () => {
  const u = await H.makeUser(1000);
  const r = await settle(Array.from({ length: 6 }, () => withdrawals.request(u.id, 600)));
  assert.equal(r.ok.length, 1);
  const b = await H.bal(u.id);
  assert.deepEqual([b.availableMinor, b.pendingWithdrawalMinor], [400, 600]);
});

test('entry racing a withdrawal of the same funds: only one wins', async () => {
  const u = await H.makeUser(1000);
  const P = await H.makePool();
  const r = await settle([H.enter(u, P, 'HOME'), withdrawals.request(u.id, 1000), H.enter(u, P, 'HOME'), withdrawals.request(u.id, 1000)]);
  assert.equal(r.ok.length, 1);
  const b = await H.bal(u.id);
  assert.equal(b.availableMinor, 0);
  assert.equal(b.lockedMinor + b.pendingWithdrawalMinor, 1000);
});

test('pool capacity holds under concurrency', async () => {
  const P = await H.makePool();
  await H.getPool().query('ALTER TABLE pools DISABLE TRIGGER pools_freeze_terms');
  await H.getPool().query('UPDATE pools SET max_entries=3 WHERE id=$1', [P.pool.id]);   // test-only setup
  await H.getPool().query('ALTER TABLE pools ENABLE TRIGGER pools_freeze_terms');
  const us = await Promise.all(Array.from({ length: 8 }, () => H.makeUser(1000)));
  const r = await settle(us.map((u) => H.enter(u, P, 'HOME')));
  assert.equal(r.ok.length, 3);
  assert.ok(r.bad.every((x) => x.reason.code === 'POOL_FULL'));
});
