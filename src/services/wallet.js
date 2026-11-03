'use strict';
const { tx, getPool } = require('../db');
const { config } = require('../config');
const { fail } = require('../errors');
const { audit } = require('../audit');
const { verifyWebhook } = require('../crypto');
const ledger = require('../ledger');
const mockpay = require('../adapters/payments-mock');
const { assertEligible } = require('./users');

const CUR = () => config.launch.currency;

async function balances(userId, c = getPool()) {
  const { rows } = await c.query(
    `SELECT type, coalesce(sum(balance_minor),0)::bigint AS b FROM account_balances
      WHERE user_id=$1 GROUP BY type`, [userId]);
  const m = Object.fromEntries(rows.map((r) => [r.type, r.b]));
  return { currency: CUR(), availableMinor: m.USER_AVAILABLE || 0, lockedMinor: m.USER_LOCKED || 0,
    pendingWithdrawalMinor: m.USER_PENDING_WITHDRAWAL || 0 };
}

/** Step 1: create a pending deposit and a simulated checkout session. No money moves yet. */
async function createDeposit(userId, amountMinor) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) fail('INVALID_AMOUNT', 'Amount must be a positive integer of minor units');
  return tx(async (c) => {
    const { rows: [u] } = await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId]);
    assertEligible(u, 'DEPOSIT');
    const { rows: [d] } = await c.query(`SELECT coalesce(sum(amount_minor),0)::bigint AS s FROM payment_intents
      WHERE user_id=$1 AND status IN ('PENDING','SUCCEEDED') AND created_at > now() - interval '24 hours'`, [userId]);
    if (d.s + amountMinor > u.daily_deposit_limit_minor) {
      fail('DEPOSIT_LIMIT', `Daily deposit limit reached (remaining ${Math.max(0, u.daily_deposit_limit_minor - d.s)} minor units)`, 403);
    }
    const bal = await balances(userId, c);
    if (bal.availableMinor + bal.lockedMinor + amountMinor > config.launch.maxBalanceMinor) fail('BALANCE_LIMIT', 'Account balance limit reached', 403);
    const { rows: [pi] } = await c.query(`INSERT INTO payment_intents(user_id, amount_minor, currency, provider)
      VALUES ($1,$2,$3,$4) RETURNING *`, [userId, amountMinor, CUR(), mockpay.NAME]);
    const co = mockpay.createCheckout({ merchantRef: pi.id, amountMinor, currency: CUR() });
    await c.query('UPDATE payment_intents SET provider_payment_id=$2 WHERE id=$1', [pi.id, co.providerPaymentId]);
    await audit(c, { actorType: 'USER', actorId: userId, action: 'deposit.created', targetType: 'payment_intent', targetId: pi.id, details: { amountMinor } });
    return { depositId: pi.id, status: 'PENDING', amountMinor, currency: CUR(), providerPaymentId: co.providerPaymentId,
      checkoutUrl: co.checkoutUrl, simulated: true };
  });
}

/**
 * Provider callback. Verifies signature + timestamp tolerance, de-duplicates on provider event id,
 * and credits the ledger idempotently (keyed on the provider payment id, so even a *different*
 * event for the same payment cannot credit twice).
 */
async function handleWebhook(rawBody, signatureHeader) {
  const v = verifyWebhook(rawBody, signatureHeader, config.payments.webhookSecret, config.payments.webhookToleranceSeconds);
  if (!v.ok) fail(v.reason, 'Webhook signature verification failed', 401);
  const evt = JSON.parse(rawBody);
  return tx(async (c) => {
    const ins = await c.query(`INSERT INTO payment_events(provider, provider_event_id, type, payload) VALUES ($1,$2,$3,$4)
      ON CONFLICT DO NOTHING RETURNING id`, [mockpay.NAME, evt.id, evt.type, evt]);
    if (!ins.rowCount) return { status: 'duplicate_ignored', eventId: evt.id };

    const d = evt.data;
    if (String(d.merchantRef).startsWith('prize-fund:')) return { status: 'acknowledged' }; // handled synchronously by ops flow

    const { rows: [pi] } = await c.query('SELECT * FROM payment_intents WHERE provider_payment_id=$1 FOR UPDATE', [d.providerPaymentId]);
    if (!pi) fail('UNKNOWN_PAYMENT', 'No matching payment intent', 404);
    if (pi.amount_minor !== d.amountMinor || pi.currency !== d.currency || pi.id !== d.merchantRef) {
      await audit(c, { actorType: 'SYSTEM', action: 'payment.mismatch', targetType: 'payment_intent', targetId: pi.id, details: { event: evt.id } });
      return { status: 'mismatch_flagged' };
    }
    if (evt.type === 'payment.failed') {
      await c.query(`UPDATE payment_intents SET status='FAILED', updated_at=now() WHERE id=$1 AND status='PENDING'`, [pi.id]);
      return { status: 'marked_failed' };
    }
    if (evt.type !== 'payment.succeeded') return { status: 'ignored' };
    if (pi.status === 'SUCCEEDED') return { status: 'already_credited' };

    const sys = await ledger.systemAccounts(c, pi.currency);
    const ua = await ledger.userAccounts(c, pi.user_id, pi.currency);
    const { txnId } = await ledger.post(c, {
      key: `deposit:${d.providerPaymentId}`, type: 'DEPOSIT', currency: pi.currency, userId: pi.user_id,
      description: `Deposit via ${mockpay.NAME} (${d.providerPaymentId})`, createdBy: 'webhook',
      transfers: [{ from: sys.clearing, to: ua.available, amountMinor: pi.amount_minor }] });
    await c.query(`UPDATE payment_intents SET status='SUCCEEDED', ledger_txn_id=$2, updated_at=now() WHERE id=$1`, [pi.id, txnId]);
    await audit(c, { actorType: 'SYSTEM', action: 'deposit.credited', targetType: 'payment_intent', targetId: pi.id,
      details: { amountMinor: pi.amount_minor, txnId, eventId: evt.id } });
    return { status: 'credited', txnId };
  });
}

/** Demo-only: complete the simulated checkout and deliver the signed webhook. */
async function simulateCheckout(userId, depositId, { succeed = true } = {}) {
  const { rows: [pi] } = await getPool().query('SELECT * FROM payment_intents WHERE id=$1 AND user_id=$2', [depositId, userId]);
  if (!pi) fail('NOT_FOUND', 'Deposit not found', 404);
  const wh = await mockpay.completeCheckout({ providerPaymentId: pi.provider_payment_id, merchantRef: pi.id,
    amountMinor: pi.amount_minor, currency: pi.currency, succeed });
  return { webhook: wh, result: await handleWebhook(wh.body, wh.signature) };
}

async function history(userId) {
  const { rows } = await getPool().query(
    `SELECT t.id, t.type, t.description, t.created_at, a.type AS account_type, p.amount_minor, t.pool_id, t.entry_id
       FROM postings p JOIN accounts a ON a.id=p.account_id JOIN ledger_transactions t ON t.id=p.transaction_id
      WHERE a.user_id=$1 ORDER BY t.created_at DESC, p.id DESC LIMIT 200`, [userId]);
  return rows.map((r) => ({ transactionId: r.id, type: r.type, description: r.description, at: r.created_at,
    account: r.account_type, amountMinor: r.amount_minor, poolId: r.pool_id, entryId: r.entry_id }));
}

module.exports = { balances, createDeposit, handleWebhook, simulateCheckout, history };
