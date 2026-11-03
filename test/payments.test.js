'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { signWebhook } = require('../src/crypto');
const { config } = require('../src/config');

test.before(H.reset);
test.after(H.closePool);

async function pendingDeposit(amount = 2500) {
  const u = await H.makeUser(0);
  const d = await H.wallet.createDeposit(u.id, amount);
  const wh = await H.mockpay.completeCheckout({ providerPaymentId: d.providerPaymentId, merchantRef: d.depositId, amountMinor: amount, currency: 'USD' });
  return { u, d, wh };
}

test('duplicate callbacks (same event delivered 8× concurrently) credit exactly once', async () => {
  const { u, wh } = await pendingDeposit();
  const rs = await Promise.allSettled(Array.from({ length: 8 }, () => H.wallet.handleWebhook(wh.body, wh.signature)));
  const statuses = rs.map((r) => (r.status === 'fulfilled' ? r.value.status : r.reason.code || r.reason.message));
  assert.equal(statuses.filter((s) => s === 'credited').length, 1, JSON.stringify(statuses));
  assert.equal((await H.bal(u.id)).availableMinor, 2500);
});

test('a different event id for the same payment cannot credit twice', async () => {
  const { u, d, wh } = await pendingDeposit(1500);
  await H.wallet.handleWebhook(wh.body, wh.signature);
  const second = H.mockpay.buildWebhook('payment.succeeded', { providerPaymentId: d.providerPaymentId, merchantRef: d.depositId, amountMinor: 1500, currency: 'USD' });
  const r = await H.wallet.handleWebhook(second.body, second.signature);
  assert.equal(r.status, 'already_credited');
  assert.equal((await H.bal(u.id)).availableMinor, 1500);
});

test('forged signature is rejected and nothing is recorded', async () => {
  const { u, wh } = await pendingDeposit();
  const forged = signWebhook(wh.body, 'not-the-secret');
  await assert.rejects(H.wallet.handleWebhook(wh.body, forged), (e) => e.code === 'BAD_SIGNATURE');
  const tampered = wh.body.replace('2500', '9999');
  await assert.rejects(H.wallet.handleWebhook(tampered, wh.signature), (e) => e.code === 'BAD_SIGNATURE');
  assert.equal((await H.bal(u.id)).availableMinor, 0);
});

test('replayed callback with a stale timestamp is rejected', async () => {
  const { u, d } = await pendingDeposit();
  const old = Math.floor(Date.now() / 1000) - config.payments.webhookToleranceSeconds - 10;
  const wh = H.mockpay.buildWebhook('payment.succeeded', { providerPaymentId: d.providerPaymentId, merchantRef: d.depositId, amountMinor: 2500, currency: 'USD' }, { t: old });
  await assert.rejects(H.wallet.handleWebhook(wh.body, wh.signature), (e) => e.code === 'TIMESTAMP_OUTSIDE_TOLERANCE');
  assert.equal((await H.bal(u.id)).availableMinor, 0);
});

test('amount mismatch between callback and intent is flagged, not credited', async () => {
  const { u, d } = await pendingDeposit(2500);
  const wh = H.mockpay.buildWebhook('payment.succeeded', { providerPaymentId: d.providerPaymentId, merchantRef: d.depositId, amountMinor: 250000, currency: 'USD' });
  const r = await H.wallet.handleWebhook(wh.body, wh.signature);
  assert.equal(r.status, 'mismatch_flagged');
  assert.equal((await H.bal(u.id)).availableMinor, 0);
});

test('daily deposit limit and self-exclusion are enforced', async () => {
  const u = await H.makeUser(0);
  await H.users.setDepositLimit(u.id, 3000);
  await H.wallet.createDeposit(u.id, 2000);
  await assert.rejects(H.wallet.createDeposit(u.id, 1500), (e) => e.code === 'DEPOSIT_LIMIT');
  await H.users.setSelfExclusion(u.id, 30);
  await assert.rejects(H.wallet.createDeposit(u.id, 100), (e) => e.code === 'SELF_EXCLUDED');
});

test('unverified or ineligible users cannot fund or enter', async () => {
  const u = await H.users.register({ email: `nv${Date.now()}@t.test`, password: 'password123' });
  await assert.rejects(H.wallet.createDeposit(u.id, 100), (e) => e.code === 'NOT_VERIFIED');
  const minor = await H.users.submitVerification(u.id, { fullName: 'Young Person', dateOfBirth: `${new Date().getUTCFullYear() - 16}-01-01`, documentNumber: 'DOC12345', jurisdiction: 'DEMO' });
  assert.equal(minor.status, 'REJECTED');
  assert.ok(minor.reasons.includes('UNDER_MINIMUM_AGE'));
});
