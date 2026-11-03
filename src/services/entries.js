'use strict';
const { tx, getPool } = require('../db');
const { fail } = require('../errors');
const { audit } = require('../audit');
const ledger = require('../ledger');
const { assertEligible } = require('./users');
const { enqueue } = require('../outbox');

/**
 * Accept an entry. All checks run inside one transaction with row locks:
 *   pool row FOR UPDATE   → serialises entries per pool (capacity, status)
 *   user row FOR UPDATE   → serialises this user's spending across pools
 *   account rows FOR UPDATE → balance check cannot race with withdrawals
 * The deadline is checked against the database clock *after* locks are held, so an entry that
 * waited on a lock past the deadline is rejected. UNIQUE(pool_id,user_id) is the final backstop.
 */
async function enter(userId, poolId, { selectionId, acceptedRulesVersion, acceptedTermsHash }) {
  return tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM pools WHERE id=$1 FOR UPDATE', [poolId]);
    if (!p || p.status === 'DRAFT') fail('NOT_FOUND', 'Pool not found', 404);
    const { rows: [u] } = await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId]);
    assertEligible(u, 'ENTER');

    const { rows: [{ now, late }] } = await c.query('SELECT clock_timestamp() AS now, $1::timestamptz <= clock_timestamp() AS late', [p.entry_deadline]);
    if (late) fail('ENTRY_DEADLINE_PASSED', `Entries closed at ${p.entry_deadline.toISOString()} (server time ${now.toISOString()})`, 409);
    if (p.status !== 'OPEN') fail('POOL_NOT_OPEN', `Pool is ${p.status}`, 409);
    if (acceptedRulesVersion !== p.rules_version || acceptedTermsHash !== p.terms_hash) {
      fail('TERMS_CHANGED', 'The terms you accepted do not match the current pool terms. Please review and confirm again.', 409,
        { rulesVersion: p.rules_version, termsHash: p.terms_hash });
    }
    const { rows: [sel] } = await c.query('SELECT * FROM selections WHERE id=$1 AND event_id=$2', [selectionId, p.event_id]);
    if (!sel) fail('INVALID_SELECTION', 'Selection is not eligible for this pool');

    const existing = await c.query('SELECT id FROM entries WHERE pool_id=$1 AND user_id=$2', [poolId, userId]);
    if (existing.rowCount) fail('ALREADY_ENTERED', 'One entry per account per pool', 409, { entryId: existing.rows[0].id });
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM entries WHERE pool_id=$1', [poolId]);
    if (n >= p.max_entries) fail('POOL_FULL', 'This pool has reached its entry limit', 409);

    const ua = await ledger.userAccounts(c, userId, p.currency);
    const locked = await ledger.account(c, { type: 'USER_LOCKED', currency: p.currency, userId, poolId });
    await ledger.lockAccounts(c, [ua.available, locked]);
    const avail = await ledger.balance(c, ua.available);
    if (avail < p.entry_amount_minor) fail('INSUFFICIENT_FUNDS', `Available ${avail} < deposit ${p.entry_amount_minor}`, 402);

    const { rows: [{ id: entryId }] } = await c.query('SELECT gen_random_uuid() AS id');
    const { txnId } = await ledger.post(c, {
      key: `entry-lock:${poolId}:${userId}`, type: 'ENTRY_DEPOSIT_LOCKED', currency: p.currency, userId, poolId, entryId,
      description: `Deposit locked for ${p.name}`, createdBy: `user:${userId}`,
      transfers: [{ from: ua.available, to: locked, amountMinor: p.entry_amount_minor }] });
    const { rows: [e] } = await c.query(`INSERT INTO entries(id, pool_id, user_id, event_id, selection_id, amount_minor, fee_minor,
        refundable_minor, rules_version, terms_hash, lock_txn_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [entryId, poolId, userId, p.event_id, selectionId, p.entry_amount_minor, p.fee_minor, p.refundable_minor, p.rules_version, p.terms_hash, txnId]);
    await audit(c, { actorType: 'USER', actorId: userId, action: 'entry.accepted', targetType: 'entry', targetId: e.id,
      details: { poolId, selection: sel.code, amountMinor: e.amount_minor, termsHash: p.terms_hash } });
    await enqueue(c, 'notify.entry_receipt', { entryId: e.id, userId }, `receipt:${e.id}`);
    return receiptFrom(e, p, sel);
  });
}

function receiptFrom(e, p, sel) {
  return {
    receiptId: `RCPT-${e.id.slice(0, 8).toUpperCase()}`, entryId: e.id, poolId: p.id, poolName: p.name,
    selection: { id: sel.id, code: sel.code, label: sel.label },
    currency: p.currency, depositMinor: e.amount_minor, feeMinor: e.fee_minor, refundableMinor: e.refundable_minor,
    prizeBudgetMinor: p.prize_budget_minor, acceptedAt: e.accepted_at, rulesVersion: e.rules_version, termsHash: e.terms_hash,
    ledgerTransactionId: e.lock_txn_id, status: e.status, fundsMode: 'SIMULATED',
  };
}

async function receipt(userId, entryId) {
  const db = getPool();
  const { rows: [e] } = await db.query('SELECT * FROM entries WHERE id=$1 AND user_id=$2', [entryId, userId]);
  if (!e) fail('NOT_FOUND', 'Entry not found', 404);
  const { rows: [p] } = await db.query('SELECT * FROM pools WHERE id=$1', [e.pool_id]);
  const { rows: [sel] } = await db.query('SELECT * FROM selections WHERE id=$1', [e.selection_id]);
  return receiptFrom(e, p, sel);
}

async function myEntries(userId) {
  const { rows } = await getPool().query(
    `SELECT e.*, p.name AS pool_name, p.status AS pool_status, p.currency, s.label AS selection_label,
            ev.name AS event_name, ev.starts_at, sl.net_credit_minor, sl.is_correct
       FROM entries e JOIN pools p ON p.id=e.pool_id JOIN selections s ON s.id=e.selection_id JOIN events ev ON ev.id=p.event_id
       LEFT JOIN settlement_lines sl ON sl.entry_id=e.id
      WHERE e.user_id=$1 ORDER BY e.accepted_at DESC`, [userId]);
  return rows.map((r) => ({ entryId: r.id, poolId: r.pool_id, poolName: r.pool_name, poolStatus: r.pool_status, eventName: r.event_name,
    eventStartsAt: r.starts_at, selection: r.selection_label, status: r.status, currency: r.currency, depositMinor: r.amount_minor,
    feeMinor: r.fee_minor, refundableMinor: r.refundable_minor, acceptedAt: r.accepted_at,
    settled: r.net_credit_minor !== null, isCorrect: r.is_correct, netCreditMinor: r.net_credit_minor }));
}

module.exports = { enter, receipt, myEntries };
