'use strict';
/**
 * Pure, deterministic economics. Integer minor units only.
 *
 * Rounding policy (documented in docs/ECONOMICS.md):
 *  - Percentages are expressed in basis points (1 bps = 0.01%).
 *  - Fee and withholding: ROUND HALF UP to the nearest minor unit.
 *  - Prize split: FLOOR per winner; the indivisible remainder returns to the prize funder.
 *  => Sum of allocations can never exceed the funded budget, and every minor unit is accounted for.
 */

function assertInt(n, name) {
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be a safe integer, got ${n}`);
}

/** round(a * bps / 10000) with half-up for non-negative a. */
function applyBpsHalfUp(amountMinor, bps) {
  assertInt(amountMinor, 'amountMinor'); assertInt(bps, 'bps');
  if (amountMinor < 0 || bps < 0 || bps > 10000) throw new Error('out of range');
  const num = BigInt(amountMinor) * BigInt(bps);
  return Number((num + 5000n) / 10000n);
}

/** Terms shown to the user before entry. */
function entryTerms({ entryAmountMinor, feeBps }) {
  const feeMinor = applyBpsHalfUp(entryAmountMinor, feeBps);
  return { depositMinor: entryAmountMinor, feeMinor, refundableMinor: entryAmountMinor - feeMinor };
}

/**
 * Bonus estimate shown before entry. Clearly an estimate: the final split depends on how many
 * entrants pick the eventual winner. `currentPicks` = existing entries on the same selection.
 */
function bonusEstimate({ prizeBudgetMinor, currentPicks, withholdingBps = 0 }) {
  const ifSoleWinner = prizeBudgetMinor;
  const ifResultNowGross = Math.floor(prizeBudgetMinor / (currentPicks + 1));
  return {
    maximumGrossMinor: ifSoleWinner,
    estimateGrossMinor: ifResultNowGross,
    estimateWithholdingMinor: applyBpsHalfUp(ifResultNowGross, withholdingBps),
    basis: `Funded budget ÷ (${currentPicks} existing picks + you). Changes as others enter.`,
    isEstimate: true,
  };
}

/**
 * Build a settlement plan.
 * @param pool    { entryAmountMinor, feeMinor, refundableMinor, prizeBudgetMinor, withholdingBps }
 * @param entries [{ id, userId, selectionId }]  — ACTIVE entries, any order
 * @param outcome { type: 'WINNER'|'TIE'|'NO_RESULT'|'CANCELLED', winningSelectionId?, supportsTie? }
 */
function planSettlement(pool, entries, outcome) {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // deterministic order
  const winners = outcome.type === 'WINNER'
    ? sorted.filter((e) => e.selectionId === outcome.winningSelectionId) : [];

  let mode = 'PAYOUT'; let reason = 'Official result confirmed; correct predictions share the prize budget.';
  if (outcome.type === 'CANCELLED') { mode = 'FULL_REFUND'; reason = 'Event cancelled: full deposit refund, no fee.'; }
  else if (outcome.type === 'NO_RESULT') { mode = 'FULL_REFUND'; reason = 'No official result: full deposit refund, no fee.'; }
  else if (outcome.type === 'TIE') { mode = 'FULL_REFUND'; reason = 'Tied outcome not supported by this pool: full deposit refund, no fee.'; }
  else if (winners.length === 0) { mode = 'FULL_REFUND'; reason = 'No correct predictions: full deposit refund, no fee.'; }

  const lines = [];
  let bonusEach = 0;
  if (mode === 'PAYOUT') bonusEach = Math.floor(pool.prizeBudgetMinor / winners.length);
  const winnerIds = new Set(winners.map((w) => w.id));

  for (const e of sorted) {
    const isCorrect = winnerIds.has(e.id);
    const fee = mode === 'PAYOUT' ? pool.feeMinor : 0;
    const refund = pool.entryAmountMinor - fee;
    const bonus = isCorrect ? bonusEach : 0;
    const withholding = applyBpsHalfUp(bonus, pool.withholdingBps || 0);
    lines.push({
      entryId: e.id, userId: e.userId, isCorrect,
      depositMinor: pool.entryAmountMinor, feeMinor: fee, refundMinor: refund,
      bonusGrossMinor: bonus, withholdingMinor: withholding, netCreditMinor: refund + bonus - withholding,
    });
  }

  const sum = (k) => lines.reduce((s, l) => s + l[k], 0);
  const bonusTotal = sum('bonusGrossMinor');
  const totals = {
    entries: lines.length,
    correct: winners.length,
    depositsMinor: sum('depositMinor'),
    feesMinor: sum('feeMinor'),
    refundsMinor: sum('refundMinor'),
    bonusGrossMinor: bonusTotal,
    withholdingMinor: sum('withholdingMinor'),
    netCreditsMinor: sum('netCreditMinor'),
    prizeBudgetMinor: pool.prizeBudgetMinor,
    prizeReturnedToFunderMinor: pool.prizeBudgetMinor - bonusTotal,
  };

  // Invariants — a plan that violates these is never executed.
  if (totals.feesMinor + totals.refundsMinor !== totals.depositsMinor) throw new Error('INVARIANT: deposits not conserved');
  if (bonusTotal > pool.prizeBudgetMinor) throw new Error('INVARIANT: prize allocation exceeds funding');
  if (totals.prizeReturnedToFunderMinor < 0) throw new Error('INVARIANT: negative prize remainder');

  return { mode, reason, bonusEachMinor: bonusEach, lines, totals };
}

/** Conventional pari-mutuel, for comparison only (not implemented as a product mode). */
function pariMutuel({ stakeMinor, takeoutBps, entries, winners }) {
  const pool = stakeMinor * entries;
  const takeout = applyBpsHalfUp(pool, takeoutBps);
  const net = pool - takeout;
  const each = winners ? Math.floor(net / winners) : 0;
  return { grossPoolMinor: pool, takeoutMinor: takeout, netPoolMinor: net, payoutEachMinor: each,
    breakageMinor: winners ? net - each * winners : net, loserLossMinor: stakeMinor };
}

function formatMinor(minor, currency = 'USD', exponent = 2) {
  const neg = minor < 0; const abs = Math.abs(minor);
  const s = String(abs).padStart(exponent + 1, '0');
  const whole = s.slice(0, s.length - exponent).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${currency} ${whole}${exponent ? '.' + s.slice(-exponent) : ''}`;
}

module.exports = { applyBpsHalfUp, entryTerms, bonusEstimate, planSettlement, pariMutuel, formatMinor };
