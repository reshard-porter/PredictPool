'use strict';
/**
 * Append-only double-entry ledger.
 *
 * Sign convention ("holdings" view): every posting moves value between accounts; a transaction's
 * postings sum to zero per currency (enforced by a deferred DB constraint trigger). Customer,
 * sponsor, escrow, fee and withholding accounts carry positive balances. PROVIDER_CLEARING mirrors
 * the asset side (cash held at the payment provider) and is the only account allowed to go
 * negative: its absolute value equals everything the platform owes or has earned.
 * Mapping to debit/credit: a negative posting is a DEBIT, a positive posting is a CREDIT.
 *
 * Balances are never stored or edited — they are always SUM(postings).
 */
const { sha256, canonical } = require('./crypto');
const { fail } = require('./errors');

const NEGATIVE_ALLOWED = new Set(['PROVIDER_CLEARING']);

async function account(c, { type, currency, userId = null, poolId = null, sponsorId = null }) {
  const params = [type, currency, userId, poolId, sponsorId, NEGATIVE_ALLOWED.has(type)];
  const ins = await c.query(
    `INSERT INTO accounts(type, currency, user_id, pool_id, sponsor_id, allow_negative)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, params);
  if (ins.rows[0]) return ins.rows[0].id;
  const { rows } = await c.query(
    `SELECT id FROM accounts WHERE type=$1 AND currency=$2
       AND user_id IS NOT DISTINCT FROM $3 AND pool_id IS NOT DISTINCT FROM $4 AND sponsor_id IS NOT DISTINCT FROM $5`,
    params.slice(0, 5));
  return rows[0].id;
}

/** Row-lock accounts in a stable order (prevents deadlocks between concurrent spenders). */
async function lockAccounts(c, ids) {
  await c.query('SELECT id FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[...new Set(ids)]]);
}

async function balance(c, accountId) {
  const { rows } = await c.query('SELECT coalesce(sum(amount_minor),0)::bigint AS b FROM postings WHERE account_id=$1', [accountId]);
  return rows[0].b;
}

/**
 * Post a balanced transaction idempotently.
 * transfers: [{ from, to, amountMinor }] (each becomes a debit+credit pair)
 * Returns { txnId, duplicate }. Re-posting the same key with different content is rejected.
 */
async function post(c, { key, type, description, currency, transfers, userId = null, poolId = null, entryId = null, createdBy }) {
  const postings = [];
  for (const t of transfers) {
    if (!Number.isSafeInteger(t.amountMinor) || t.amountMinor < 0) fail('LEDGER_BAD_AMOUNT', 'amount must be a non-negative integer');
    if (t.amountMinor === 0) continue;
    postings.push({ accountId: t.from, amountMinor: -t.amountMinor });
    postings.push({ accountId: t.to, amountMinor: t.amountMinor });
  }
  const payloadHash = sha256(canonical({ type, currency, postings }));

  const ins = await c.query(
    `INSERT INTO ledger_transactions(idempotency_key, type, description, payload_hash, user_id, pool_id, entry_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [key, type, description, payloadHash, userId, poolId, entryId, createdBy]);
  if (!ins.rows[0]) {
    const { rows } = await c.query('SELECT id, payload_hash FROM ledger_transactions WHERE idempotency_key=$1', [key]);
    if (rows[0].payload_hash !== payloadHash) fail('IDEMPOTENCY_CONFLICT', `ledger key ${key} reused with different content`, 409);
    return { txnId: rows[0].id, duplicate: true };
  }
  const txnId = ins.rows[0].id;
  if (postings.length === 0) fail('LEDGER_EMPTY', 'transaction has no non-zero postings');
  const vals = []; const args = [];
  postings.forEach((p, i) => { vals.push(`($1, $${i * 2 + 3}, $2, $${i * 2 + 4})`); args.push(p.accountId, p.amountMinor); });
  await c.query(`INSERT INTO postings(transaction_id, account_id, currency, amount_minor) VALUES ${vals.join(',')}`,
    [txnId, currency, ...args]);
  return { txnId, duplicate: false };
}

/** Platform-wide accounts for a currency. */
async function systemAccounts(c, currency) {
  return {
    clearing: await account(c, { type: 'PROVIDER_CLEARING', currency }),
    fees: await account(c, { type: 'FEE_REVENUE', currency }),
    withholding: await account(c, { type: 'WITHHOLDING_PAYABLE', currency }),
  };
}

async function userAccounts(c, userId, currency) {
  return {
    available: await account(c, { type: 'USER_AVAILABLE', currency, userId }),
    pendingWithdrawal: await account(c, { type: 'USER_PENDING_WITHDRAWAL', currency, userId }),
  };
}

module.exports = { account, lockAccounts, balance, post, systemAccounts, userAccounts };
