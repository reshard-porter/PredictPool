'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/economics');

const pool = (o = {}) => ({ entryAmountMinor: 1000, feeMinor: 50, refundableMinor: 950, prizeBudgetMinor: 10000, withholdingBps: 0, ...o });
const ents = (picks) => picks.map((s, i) => ({ id: `e${String(i).padStart(3, '0')}`, userId: `u${i}`, selectionId: s }));

test('fee rounding is half-up and deterministic', () => {
  assert.equal(E.applyBpsHalfUp(1000, 500), 50);
  assert.equal(E.applyBpsHalfUp(1001, 500), 50);   // 50.05 → 50
  assert.equal(E.applyBpsHalfUp(1010, 500), 51);   // 50.50 → 51 (half up)
  assert.equal(E.applyBpsHalfUp(1, 5000), 1);      // 0.5 → 1
  assert.equal(E.applyBpsHalfUp(1, 4999), 0);
  assert.equal(E.applyBpsHalfUp(2500, 400), 100);
  const t = E.entryTerms({ entryAmountMinor: 999, feeBps: 333 });
  assert.equal(t.feeMinor + t.refundableMinor, 999);
});

test('worked example: 7 entries, 3 correct, prize 100.00 split with 1 minor unit remainder', () => {
  const plan = E.planSettlement(pool(), ents(['A', 'B', 'A', 'B', 'A', 'B', 'B']), { type: 'WINNER', winningSelectionId: 'A' });
  assert.equal(plan.mode, 'PAYOUT');
  assert.equal(plan.bonusEachMinor, 3333);
  assert.deepEqual(plan.totals, { entries: 7, correct: 3, depositsMinor: 7000, feesMinor: 350, refundsMinor: 6650, bonusGrossMinor: 9999,
    withholdingMinor: 0, netCreditsMinor: 16649, prizeBudgetMinor: 10000, prizeReturnedToFunderMinor: 1 });
  // Conservation: deposits + prize = credits + fees + withholding + returned prize
  const t = plan.totals;
  assert.equal(t.depositsMinor + t.prizeBudgetMinor, t.netCreditsMinor + t.feesMinor + t.withholdingMinor + t.prizeReturnedToFunderMinor);
  const winner = plan.lines.find((l) => l.isCorrect);
  assert.deepEqual([winner.refundMinor, winner.bonusGrossMinor, winner.netCreditMinor], [950, 3333, 4283]);
  const loser = plan.lines.find((l) => !l.isCorrect);
  assert.deepEqual([loser.feeMinor, loser.netCreditMinor], [50, 950]);
});

test('no correct predictions → full refund, no fee, prize returns to funder', () => {
  const plan = E.planSettlement(pool(), ents(['B', 'B', 'C']), { type: 'WINNER', winningSelectionId: 'A' });
  assert.equal(plan.mode, 'FULL_REFUND');
  assert.ok(plan.lines.every((l) => l.feeMinor === 0 && l.netCreditMinor === 1000));
  assert.equal(plan.totals.prizeReturnedToFunderMinor, 10000);
});

test('cancelled / tie / no result → full refund without fee', () => {
  for (const type of ['CANCELLED', 'TIE', 'NO_RESULT']) {
    const plan = E.planSettlement(pool(), ents(['A', 'B']), { type });
    assert.equal(plan.mode, 'FULL_REFUND', type);
    assert.equal(plan.totals.feesMinor, 0);
    assert.equal(plan.totals.refundsMinor, 2000);
  }
});

test('withholding (hypothetical rule for mechanics only) rounds half-up on the bonus only', () => {
  const plan = E.planSettlement(pool({ withholdingBps: 1000, prizeBudgetMinor: 10005 }), ents(['A', 'A', 'B']), { type: 'WINNER', winningSelectionId: 'A' });
  const w = plan.lines.find((l) => l.isCorrect);
  assert.equal(w.bonusGrossMinor, 5002);
  assert.equal(w.withholdingMinor, 500);            // 500.2 → 500
  assert.equal(w.netCreditMinor, 950 + 5002 - 500);
  assert.equal(plan.totals.prizeReturnedToFunderMinor, 1);
});

test('property: random pools never over-allocate and always conserve every minor unit', () => {
  let seed = 42; const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
  for (let i = 0; i < 2000; i++) {
    const entry = 1 + rnd(100000); const feeBps = rnd(10001); const prize = 1 + rnd(10000000);
    const fee = E.applyBpsHalfUp(entry, feeBps);
    const picks = Array.from({ length: 1 + rnd(60) }, () => ['A', 'B', 'C'][rnd(3)]);
    const plan = E.planSettlement({ entryAmountMinor: entry, feeMinor: fee, refundableMinor: entry - fee, prizeBudgetMinor: prize, withholdingBps: rnd(3000) },
      ents(picks), { type: 'WINNER', winningSelectionId: 'A' });
    const t = plan.totals;
    assert.ok(t.bonusGrossMinor <= prize);
    if (t.correct === 0) assert.equal(t.prizeReturnedToFunderMinor, prize);
    else assert.ok(t.prizeReturnedToFunderMinor >= 0 && t.prizeReturnedToFunderMinor < t.correct);
    assert.equal(t.depositsMinor + prize, t.netCreditsMinor + t.feesMinor + t.withholdingMinor + t.prizeReturnedToFunderMinor);
    // Order independence (determinism)
    const again = E.planSettlement({ entryAmountMinor: entry, feeMinor: fee, refundableMinor: entry - fee, prizeBudgetMinor: prize, withholdingBps: 0 },
      ents(picks).reverse(), { type: 'WINNER', winningSelectionId: 'A' });
    assert.equal(again.totals.bonusGrossMinor, t.bonusGrossMinor);
  }
});

test('pari-mutuel comparison model is computed separately', () => {
  const pm = E.pariMutuel({ stakeMinor: 1000, takeoutBps: 500, entries: 7, winners: 3 });
  assert.deepEqual(pm, { grossPoolMinor: 7000, takeoutMinor: 350, netPoolMinor: 6650, payoutEachMinor: 2216, breakageMinor: 2, loserLossMinor: 1000 });
});
