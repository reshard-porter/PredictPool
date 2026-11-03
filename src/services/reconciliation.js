'use strict';
const { getPool } = require('../db');
const mockpay = require('../adapters/payments-mock');
const { verifyAuditChain } = require('../audit');

/** Ledger invariants. Each check returns { name, ok, detail }. */
async function invariants() {
  const db = getPool();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const unbal = await db.query(`SELECT transaction_id, currency, sum(amount_minor) s FROM postings GROUP BY 1,2 HAVING sum(amount_minor) <> 0`);
  add('Every ledger transaction balances per currency', unbal.rowCount === 0, `${unbal.rowCount} unbalanced`);

  const tot = await db.query(`SELECT currency, sum(amount_minor)::bigint s FROM postings GROUP BY 1`);
  add('Ledger sums to zero per currency', tot.rows.every((r) => r.s === 0), tot.rows);

  const neg = await db.query(`SELECT id, type, balance_minor FROM account_balances WHERE NOT allow_negative AND balance_minor < 0`);
  add('No customer/escrow account is negative', neg.rowCount === 0, neg.rows);

  // Customer deposits cover promised refunds: locked balance per pool = active entries × deposit.
  const cover = await db.query(`
    SELECT p.id, p.name, p.status,
      (SELECT coalesce(sum(balance_minor),0) FROM account_balances b WHERE b.pool_id=p.id AND b.type='USER_LOCKED')::bigint AS locked,
      (SELECT count(*) FROM entries e WHERE e.pool_id=p.id AND e.status='ACTIVE')::bigint * p.entry_amount_minor AS promised
    FROM pools p`);
  const bad = cover.rows.filter((r) => r.locked !== r.promised);
  add('Locked deposits = promised refunds for every pool', bad.length === 0, bad);

  // Prize allocations never exceed confirmed funding.
  const prize = await db.query(`
    SELECT p.id, p.prize_budget_minor,
      coalesce((SELECT sum(bonus_gross_minor) FROM settlement_lines sl WHERE sl.pool_id=p.id),0)::bigint AS allocated,
      (SELECT coalesce(sum(balance_minor),0) FROM account_balances b WHERE b.pool_id=p.id AND b.type='POOL_PRIZE_ESCROW')::bigint AS escrow,
      p.status FROM pools p`);
  const over = prize.rows.filter((r) => r.allocated > r.prize_budget_minor
    || (['OPEN', 'LOCKED', 'RESULT_REVIEW', 'DISPUTED', 'RESULT_CONFIRMED'].includes(r.status) && r.escrow !== r.prize_budget_minor));
  add('Prize allocations ≤ confirmed funding; open pools fully escrowed', over.length === 0, over);

  const credited = await db.query(`SELECT count(*)::int n FROM settlement_lines WHERE ledger_txn_id IS NULL
     AND run_id IN (SELECT id FROM settlement_runs WHERE status='COMPLETED')`);
  add('Every settlement credit has a ledger transaction', credited.rows[0].n === 0, credited.rows[0]);

  const audit = await verifyAuditChain(db);
  add('Audit log hash chain intact', audit.ok, audit);
  return { ok: checks.every((c) => c.ok), checks };
}

/** Compare internal payment records with the provider's books. */
async function providerReconciliation() {
  const db = getPool();
  const prov = await mockpay.listTransactions();
  const byRef = new Map(prov.map((t) => [t.merchant_ref, t]));
  const issues = [];

  const { rows: intents } = await db.query('SELECT * FROM payment_intents');
  for (const i of intents) {
    const t = byRef.get(i.id);
    if (i.status === 'SUCCEEDED' && (!t || t.status !== 'SUCCEEDED' || t.amount_minor !== i.amount_minor)) issues.push({ kind: 'DEPOSIT_NOT_AT_PROVIDER', id: i.id });
    if (i.status === 'PENDING' && t && t.status === 'SUCCEEDED') issues.push({ kind: 'PROVIDER_PAID_NOT_CREDITED', id: i.id, hint: 'missed webhook — replay' });
  }
  const { rows: wds } = await db.query('SELECT * FROM withdrawals');
  for (const w of wds) {
    const t = byRef.get(w.id);
    if (w.status === 'PAID' && (!t || t.status !== 'SUCCEEDED')) issues.push({ kind: 'PAYOUT_NOT_AT_PROVIDER', id: w.id });
    if (w.status === 'FAILED' && t && t.status === 'SUCCEEDED') issues.push({ kind: 'PAYOUT_SENT_BUT_REVERSED', id: w.id });
    if (['REQUESTED', 'PROCESSING'].includes(w.status) && t) issues.push({ kind: 'PAYOUT_PENDING_INTERNALLY', id: w.id, providerStatus: t.status });
  }
  const providerNet = prov.filter((t) => t.status === 'SUCCEEDED')
    .reduce((s, t) => s + (t.kind === 'PAYIN' ? t.amount_minor : -t.amount_minor), 0);
  const { rows: [cl] } = await db.query(`SELECT coalesce(sum(balance_minor),0)::bigint AS b FROM account_balances WHERE type='PROVIDER_CLEARING'`);
  const ledgerNet = -cl.b;
  if (providerNet !== ledgerNet) issues.push({ kind: 'CLEARING_MISMATCH', providerNet, ledgerNet });
  return { ok: issues.length === 0, providerNetMinor: providerNet, ledgerClearingMinor: ledgerNet, issues };
}

async function platformTotals() {
  const { rows } = await getPool().query(`SELECT type, currency, sum(balance_minor)::bigint AS total FROM account_balances GROUP BY 1,2 ORDER BY 1`);
  return rows;
}

module.exports = { invariants, providerReconciliation, platformTotals };
