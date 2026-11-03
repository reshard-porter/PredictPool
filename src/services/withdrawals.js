'use strict';
/**
 * Withdrawals — independent of pool settlement.
 *   request : AVAILABLE → PENDING_WITHDRAWAL (hold), enqueue payout   [one DB txn, row-locked]
 *   process : call provider (outside DB txn), then
 *             PAID   → PENDING_WITHDRAWAL → PROVIDER_CLEARING
 *             FAILED → PENDING_WITHDRAWAL → AVAILABLE (reversal)
 *             transient error → outbox retry; provider is idempotent on merchant_ref (= withdrawal id)
 */
const { tx, getPool } = require('../db');
const { fail } = require('../errors');
const { audit } = require('../audit');
const ledger = require('../ledger');
const mockpay = require('../adapters/payments-mock');
const { enqueue } = require('../outbox');
const { assertEligible } = require('./users');
const { config } = require('../config');

async function request(userId, amountMinor) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) fail('INVALID_AMOUNT', 'Amount must be a positive integer of minor units');
  return tx(async (c) => {
    const { rows: [u] } = await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId]);
    assertEligible(u, 'WITHDRAW');
    const cur = config.launch.currency;
    const ua = await ledger.userAccounts(c, userId, cur);
    await ledger.lockAccounts(c, [ua.available, ua.pendingWithdrawal]);
    const avail = await ledger.balance(c, ua.available);
    if (avail < amountMinor) fail('INSUFFICIENT_FUNDS', `Available ${avail} < requested ${amountMinor}`, 402);
    const { rows: [{ id }] } = await c.query('SELECT gen_random_uuid() AS id');
    const { txnId } = await ledger.post(c, { key: `withdrawal-hold:${id}`, type: 'WITHDRAWAL_HOLD', currency: cur, userId,
      description: 'Withdrawal requested (funds held)', createdBy: `user:${userId}`,
      transfers: [{ from: ua.available, to: ua.pendingWithdrawal, amountMinor }] });
    const { rows: [w] } = await c.query(`INSERT INTO withdrawals(id, user_id, amount_minor, currency, provider, hold_txn_id)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [id, userId, amountMinor, cur, mockpay.NAME, txnId]);
    await enqueue(c, 'withdrawal.process', { withdrawalId: id }, `withdrawal:${id}`);
    await audit(c, { actorType: 'USER', actorId: userId, action: 'withdrawal.requested', targetType: 'withdrawal', targetId: id, details: { amountMinor } });
    return out(w);
  });
}

async function processPayout(withdrawalId) {
  const { rows: [w0] } = await getPool().query(`UPDATE withdrawals SET status='PROCESSING', attempts=attempts+1, updated_at=now()
      WHERE id=$1 AND status IN ('REQUESTED','PROCESSING') RETURNING *`, [withdrawalId]);
  if (!w0) return { status: 'already_final' };
  const res = await mockpay.payout({ merchantRef: w0.id, amountMinor: w0.amount_minor, currency: w0.currency }); // may throw (transient)

  return tx(async (c) => {
    const { rows: [w] } = await c.query('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE', [withdrawalId]);
    if (['PAID', 'FAILED'].includes(w.status)) return out(w);
    const sys = await ledger.systemAccounts(c, w.currency);
    const ua = await ledger.userAccounts(c, w.user_id, w.currency);
    if (res.status === 'SUCCEEDED') {
      const { txnId } = await ledger.post(c, { key: `withdrawal-paid:${w.id}`, type: 'WITHDRAWAL_PAID', currency: w.currency, userId: w.user_id,
        description: `Withdrawal paid (${res.providerPayoutId})`, createdBy: 'worker',
        transfers: [{ from: ua.pendingWithdrawal, to: sys.clearing, amountMinor: w.amount_minor }] });
      await c.query(`UPDATE withdrawals SET status='PAID', provider_payout_id=$2, final_txn_id=$3, updated_at=now() WHERE id=$1`, [w.id, res.providerPayoutId, txnId]);
    } else {
      const { txnId } = await ledger.post(c, { key: `withdrawal-reversal:${w.id}`, type: 'WITHDRAWAL_REVERSED', currency: w.currency, userId: w.user_id,
        description: `Withdrawal failed (${res.failureReason || 'declined'}); funds returned`, createdBy: 'worker',
        transfers: [{ from: ua.pendingWithdrawal, to: ua.available, amountMinor: w.amount_minor }] });
      await c.query(`UPDATE withdrawals SET status='FAILED', provider_payout_id=$2, failure_reason=$3, final_txn_id=$4, updated_at=now() WHERE id=$1`,
        [w.id, res.providerPayoutId, res.failureReason || 'DECLINED', txnId]);
    }
    await audit(c, { actorType: 'SYSTEM', action: `withdrawal.${res.status.toLowerCase()}`, targetType: 'withdrawal', targetId: w.id, details: { providerPayoutId: res.providerPayoutId } });
    const { rows: [f] } = await c.query('SELECT * FROM withdrawals WHERE id=$1', [w.id]);
    return out(f);
  });
}

const out = (w) => ({ withdrawalId: w.id, status: w.status, amountMinor: w.amount_minor, currency: w.currency,
  failureReason: w.failure_reason, attempts: w.attempts, createdAt: w.created_at, simulated: true });

async function list(userId) {
  const { rows } = await getPool().query('SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC', [userId]);
  return rows.map(out);
}

module.exports = { request, processPayout, list };
