'use strict';
/**
 * Pool settlement — deterministic, idempotent, resumable.
 *
 *  1. begin(): under a pool row lock, compute the plan from ACTIVE entries + confirmed outcome,
 *     persist settlement_run + one settlement_line per entry, move pool to SETTLING.
 *     If a run already exists, the persisted plan is reused (never recomputed).
 *  2. postLines(): each line posts one ledger transaction keyed `settle:<entryId>`; a retry after
 *     a crash skips lines that already carry a ledger_txn_id and the ledger key blocks doubles.
 *  3. finalize(): sweep the prize remainder back to the funder, assert escrow and locked deposits
 *     are exactly zero, mark the pool SETTLED/REFUNDED.
 * Withdrawals are a separate flow; settlement only ever credits USER_AVAILABLE.
 */
const { tx, getPool } = require('../db');
const { fail } = require('../errors');
const { audit } = require('../audit');
const { sha256, canonical } = require('../crypto');
const econ = require('../economics');
const ledger = require('../ledger');
const { enqueue } = require('../outbox');
const { latestResult } = require('./results');
const { transition } = require('./pools');

function poolTerms(p) {
  return { entryAmountMinor: p.entry_amount_minor, feeMinor: p.fee_minor, refundableMinor: p.refundable_minor,
    prizeBudgetMinor: p.prize_budget_minor, withholdingBps: p.withholding_bps };
}

async function outcomeFor(c, p) {
  if (p.status === 'CANCELLED') return { type: 'CANCELLED' };
  const r = await latestResult(c, p.event_id);
  if (!r) fail('NO_RESULT', 'No result recorded', 409);
  if (r.outcome_type === 'WINNER') {
    if (p.winning_selection_id !== r.winning_selection_id) fail('RESULT_NOT_CONFIRMED', 'Confirmed winner does not match latest result', 409);
    return { type: 'WINNER', winningSelectionId: r.winning_selection_id, resultId: r.id };
  }
  return { type: r.outcome_type, resultId: r.id };
}

async function loadEntries(c, poolId) {
  const { rows } = await c.query(`SELECT id, user_id, selection_id FROM entries WHERE pool_id=$1 AND status='ACTIVE'`, [poolId]);
  return rows.map((r) => ({ id: r.id, userId: r.user_id, selectionId: r.selection_id }));
}

/** Read-only preview for operations. */
async function preview(poolId) {
  const c = getPool();
  const { rows: [p] } = await c.query('SELECT * FROM pools WHERE id=$1', [poolId]);
  if (!p) fail('NOT_FOUND', 'Pool not found', 404);
  const run = await c.query('SELECT * FROM settlement_runs WHERE pool_id=$1', [poolId]);
  if (run.rows[0]) {
    const { rows: lines } = await c.query('SELECT * FROM settlement_lines WHERE run_id=$1 ORDER BY entry_id', [run.rows[0].id]);
    return { persisted: true, run: run.rows[0], mode: run.rows[0].outcome, reason: run.rows[0].reason, totals: run.rows[0].totals, lines: lines.map(lineOut) };
  }
  if (!['RESULT_CONFIRMED', 'CANCELLED'].includes(p.status)) fail('NOT_READY', `Pool is ${p.status}; preview requires a confirmed result or cancellation`, 409);
  const plan = econ.planSettlement(poolTerms(p), await loadEntries(c, poolId), await outcomeFor(c, p));
  return { persisted: false, ...plan };
}

const lineOut = (l) => ({ entryId: l.entry_id, userId: l.user_id, isCorrect: l.is_correct, depositMinor: l.deposit_minor, feeMinor: l.fee_minor,
  refundMinor: l.refund_minor, bonusGrossMinor: l.bonus_gross_minor, withholdingMinor: l.withholding_minor, netCreditMinor: l.net_credit_minor,
  ledgerTransactionId: l.ledger_txn_id });

async function begin(actor, poolId) {
  return tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM pools WHERE id=$1 FOR UPDATE', [poolId]);
    if (!p) fail('NOT_FOUND', 'Pool not found', 404);
    const existing = await c.query('SELECT * FROM settlement_runs WHERE pool_id=$1', [poolId]);
    if (existing.rows[0]) {
      if (existing.rows[0].status === 'IN_PROGRESS') await c.query('UPDATE settlement_runs SET attempts=attempts+1 WHERE id=$1', [existing.rows[0].id]);
      return existing.rows[0];
    }
    if (p.status === 'DISPUTED') fail('DISPUTE_OPEN', 'Settlement is held while a dispute is open', 409);
    if (!['RESULT_CONFIRMED', 'CANCELLED'].includes(p.status)) fail('NOT_READY', `Pool is ${p.status}`, 409);

    const outcome = await outcomeFor(c, p);
    const plan = econ.planSettlement(poolTerms(p), await loadEntries(c, poolId), outcome);
    const planHash = sha256(canonical(plan));
    const { rows: [run] } = await c.query(`INSERT INTO settlement_runs(pool_id, outcome, reason, result_id, plan_hash, totals, started_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [poolId, plan.mode, plan.reason, outcome.resultId || null, planHash, plan.totals, `${actor.type}:${actor.id || ''}`]);
    for (const l of plan.lines) {
      await c.query(`INSERT INTO settlement_lines(run_id, pool_id, entry_id, user_id, is_correct, deposit_minor, fee_minor, refund_minor,
          bonus_gross_minor, withholding_minor, net_credit_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [run.id, poolId, l.entryId, l.userId, l.isCorrect, l.depositMinor, l.feeMinor, l.refundMinor, l.bonusGrossMinor, l.withholdingMinor, l.netCreditMinor]);
    }
    await transition(c, poolId, ['RESULT_CONFIRMED', 'CANCELLED'], 'SETTLING', actor, plan.reason);
    await c.query('UPDATE pools SET settlement_outcome=$2, settlement_reason=$3 WHERE id=$1', [poolId, plan.mode, plan.reason]);
    await audit(c, { actorType: actor.type, actorId: actor.id, action: 'settlement.started', targetType: 'pool', targetId: poolId,
      details: { planHash, totals: plan.totals } });
    return run;
  });
}

async function postLine(c, p, line, accts) {
  const locked = await ledger.account(c, { type: 'USER_LOCKED', currency: p.currency, userId: line.user_id, poolId: p.id });
  const available = await ledger.account(c, { type: 'USER_AVAILABLE', currency: p.currency, userId: line.user_id });
  const transfers = [
    { from: locked, to: accts.fees, amountMinor: line.fee_minor },
    { from: locked, to: available, amountMinor: line.refund_minor },
    { from: accts.escrow, to: available, amountMinor: line.bonus_gross_minor - line.withholding_minor },
    { from: accts.escrow, to: accts.withholding, amountMinor: line.withholding_minor },
  ];
  const { txnId } = await ledger.post(c, {
    key: `settle:${line.entry_id}`, type: line.fee_minor ? 'SETTLEMENT_PAYOUT' : 'SETTLEMENT_FULL_REFUND', currency: p.currency,
    userId: line.user_id, poolId: p.id, entryId: line.entry_id, createdBy: 'settlement',
    description: `Settlement for ${p.name}: refund ${line.refund_minor}, fee ${line.fee_minor}, bonus ${line.bonus_gross_minor}, withholding ${line.withholding_minor}`,
    transfers });
  await c.query('UPDATE settlement_lines SET ledger_txn_id=$2 WHERE id=$1 AND ledger_txn_id IS NULL', [line.id, txnId]);
  await c.query(`UPDATE entries SET status=$2 WHERE id=$1 AND status='ACTIVE'`, [line.entry_id, line.fee_minor ? 'SETTLED' : 'REFUNDED']);
}

/**
 * Execute (or resume) settlement. `opts.failAfterLines` injects a crash for retry tests.
 */
async function execute(actor, poolId, opts = {}) {
  const run = await begin(actor, poolId);
  if (run.status === 'COMPLETED') return { status: 'already_completed', runId: run.id, totals: run.totals };

  const { rows: [p] } = await getPool().query('SELECT * FROM pools WHERE id=$1', [poolId]);
  const { rows: pending } = await getPool().query('SELECT * FROM settlement_lines WHERE run_id=$1 AND ledger_txn_id IS NULL ORDER BY entry_id', [run.id]);
  let posted = 0;
  for (const line of pending) {
    if (opts.failAfterLines !== undefined && posted >= opts.failAfterLines) throw new Error('SIMULATED_CRASH during settlement');
    await tx(async (c) => {
      const sys = await ledger.systemAccounts(c, p.currency);
      const escrow = await ledger.account(c, { type: 'POOL_PRIZE_ESCROW', currency: p.currency, poolId });
      await postLine(c, p, line, { fees: sys.fees, withholding: sys.withholding, escrow });
    });
    posted++;
  }

  return tx(async (c) => {
    const { rows: [r] } = await c.query('SELECT * FROM settlement_runs WHERE id=$1 FOR UPDATE', [run.id]);
    if (r.status === 'COMPLETED') return { status: 'already_completed', runId: r.id, totals: r.totals };
    const left = await c.query('SELECT 1 FROM settlement_lines WHERE run_id=$1 AND ledger_txn_id IS NULL', [run.id]);
    if (left.rowCount) fail('SETTLEMENT_INCOMPLETE', 'Lines remain unposted; retry', 409);

    const escrow = await ledger.account(c, { type: 'POOL_PRIZE_ESCROW', currency: p.currency, poolId });
    const sponsorAcct = await ledger.account(c, { type: 'SPONSOR_AVAILABLE', currency: p.currency, sponsorId: p.sponsor_id });
    await ledger.lockAccounts(c, [escrow]);
    const remaining = await ledger.balance(c, escrow);
    if (p.opened_at && remaining !== r.totals.prizeReturnedToFunderMinor) {
      fail('INVARIANT_ESCROW', `Escrow ${remaining} ≠ planned remainder ${r.totals.prizeReturnedToFunderMinor}`, 500);
    }
    if (remaining > 0) {
      await ledger.post(c, { key: `settle-remainder:${poolId}`, type: 'PRIZE_REMAINDER_RETURNED', currency: p.currency, poolId,
        description: 'Unallocated prize budget returned to funder', createdBy: 'settlement',
        transfers: [{ from: escrow, to: sponsorAcct, amountMinor: remaining }] });
    }
    const { rows: [{ s }] } = await c.query(`SELECT coalesce(sum(b.balance_minor),0)::bigint AS s FROM account_balances b
       WHERE b.pool_id=$1 AND b.type IN ('USER_LOCKED','POOL_PRIZE_ESCROW')`, [poolId]);
    if (s !== 0) fail('INVARIANT_POOL_NOT_EMPTY', `Pool accounts hold ${s} after settlement`, 500);

    await c.query(`UPDATE settlement_runs SET status='COMPLETED', completed_at=now() WHERE id=$1`, [run.id]);
    const final = r.outcome === 'PAYOUT' ? 'SETTLED' : 'REFUNDED';
    await transition(c, poolId, 'SETTLING', final, actor, r.reason);
    await c.query('UPDATE pools SET settled_at=now() WHERE id=$1', [poolId]);
    await enqueue(c, 'notify.pool_settled', { poolId }, `settled:${poolId}`);
    return { status: final, runId: r.id, totals: r.totals };
  });
}

/** Ops action: queue settlement for the worker (idempotent via outbox dedupe key). */
async function requestSettlement(admin, poolId) {
  return tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT status FROM pools WHERE id=$1', [poolId]);
    if (!p) fail('NOT_FOUND', 'Pool not found', 404);
    if (!['RESULT_CONFIRMED', 'CANCELLED', 'SETTLING'].includes(p.status)) fail('NOT_READY', `Pool is ${p.status}`, 409);
    await enqueue(c, 'settlement.execute', { poolId, requestedBy: admin.id }, `settle:${poolId}`);
    await audit(c, { actorType: 'ADMIN', actorId: admin.id, action: 'settlement.requested', targetType: 'pool', targetId: poolId });
    return { queued: true };
  });
}

async function statement(userId, entryId) {
  const { rows: [l] } = await getPool().query(
    `SELECT sl.*, p.name AS pool_name, p.currency, r.outcome, r.reason, r.completed_at, s.label AS selection
       FROM settlement_lines sl JOIN pools p ON p.id=sl.pool_id JOIN settlement_runs r ON r.id=sl.run_id
       JOIN entries e ON e.id=sl.entry_id JOIN selections s ON s.id=e.selection_id
      WHERE sl.entry_id=$1 AND sl.user_id=$2`, [entryId, userId]);
  if (!l) fail('NOT_FOUND', 'No settlement for this entry yet', 404);
  return { entryId, poolName: l.pool_name, selection: l.selection, currency: l.currency, outcome: l.outcome, reason: l.reason,
    isCorrect: l.is_correct, settledAt: l.completed_at, ledgerTransactionId: l.ledger_txn_id,
    items: [
      { label: 'Deposit', amountMinor: l.deposit_minor },
      { label: 'Platform fee', amountMinor: -l.fee_minor },
      { label: 'Returned deposit', amountMinor: l.refund_minor, subtotal: true },
      { label: 'Prize bonus (gross)', amountMinor: l.bonus_gross_minor },
      { label: 'Withholding', amountMinor: -l.withholding_minor },
      { label: 'Net credit to available balance', amountMinor: l.net_credit_minor, total: true },
    ] };
}

module.exports = { preview, execute, requestSettlement, statement };
