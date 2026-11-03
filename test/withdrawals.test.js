'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const W = require('../src/services/withdrawals');
const recon = require('../src/services/reconciliation');

test.before(H.reset);
test.after(H.closePool);

test('successful withdrawal moves funds out through the provider', async () => {
  const u = await H.makeUser(2000);
  const w = await W.request(u.id, 1500);
  const done = await W.processPayout(w.withdrawalId);
  assert.equal(done.status, 'PAID');
  const b = await H.bal(u.id);
  assert.deepEqual([b.availableMinor, b.pendingWithdrawalMinor], [500, 0]);
});

test('failed (declined) withdrawal returns funds to available balance', async () => {
  const u = await H.makeUser(2000);
  await H.mockpay.setSetting('payout_mode', 'DECLINE');
  const w = await W.request(u.id, 2000);
  assert.equal((await H.bal(u.id)).availableMinor, 0);
  const done = await W.processPayout(w.withdrawalId);
  await H.mockpay.setSetting('payout_mode', 'NORMAL');
  assert.equal(done.status, 'FAILED');
  assert.equal(done.failureReason, 'BENEFICIARY_ACCOUNT_DECLINED');
  const b = await H.bal(u.id);
  assert.deepEqual([b.availableMinor, b.pendingWithdrawalMinor], [2000, 0]);
  // Re-processing a final withdrawal is a no-op.
  assert.equal((await W.processPayout(w.withdrawalId)).status, 'already_final');
});

test('transient provider timeout keeps funds held, retry succeeds once', async () => {
  const u = await H.makeUser(1000);
  await H.mockpay.setSetting('payout_mode', 'TIMEOUT');
  const w = await W.request(u.id, 1000);
  await assert.rejects(W.processPayout(w.withdrawalId), /timeout/);
  assert.equal((await H.bal(u.id)).pendingWithdrawalMinor, 1000);
  await H.mockpay.setSetting('payout_mode', 'NORMAL');
  assert.equal((await W.processPayout(w.withdrawalId)).status, 'PAID');
});

test('lost provider response: retry finds the existing payout, no double payment', async () => {
  const u = await H.makeUser(1000);
  await H.mockpay.setSetting('payout_mode', 'TIMEOUT_AFTER_COMMIT');
  const w = await W.request(u.id, 1000);
  await assert.rejects(W.processPayout(w.withdrawalId), /lost/);
  await H.mockpay.setSetting('payout_mode', 'NORMAL');
  assert.equal((await W.processPayout(w.withdrawalId)).status, 'PAID');
  const prov = (await H.mockpay.listTransactions()).filter((t) => t.merchant_ref === w.withdrawalId);
  assert.equal(prov.length, 1);
  const r = await recon.providerReconciliation();
  assert.ok(r.ok, JSON.stringify(r.issues));
});

test('self-excluded users can still withdraw', async () => {
  const u = await H.makeUser(1000);
  await H.users.setSelfExclusion(u.id, 7);
  const w = await W.request(u.id, 1000);
  assert.equal((await W.processPayout(w.withdrawalId)).status, 'PAID');
});
