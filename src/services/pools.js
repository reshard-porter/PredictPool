'use strict';
const { tx, getPool } = require('../db');
const { config } = require('../config');
const { fail } = require('../errors');
const { audit } = require('../audit');
const { sha256, canonical } = require('../crypto');
const econ = require('../economics');
const ledger = require('../ledger');
const mockpay = require('../adapters/payments-mock');
const results = require('../adapters/results-mock');
const { enqueue } = require('../outbox');

const RULES_VERSION = 'refundable-v1.0';

const SETTLEMENT_RULES = [
  'Every valid entry receives its deposit back minus the disclosed platform fee after the official result is final.',
  'Correct predictions share the separately funded prize budget equally (floor to the minor unit); the indivisible remainder returns to the prize funder.',
  'Cancelled events, tied outcomes this pool does not support, and pools with no correct predictions: full deposit refund, no fee; the prize budget returns to the funder.',
  'Postponement: if the event is rescheduled within the postponement window of its original start, the pool stays valid; otherwise it is treated as cancelled.',
  'Disqualification: the official source\'s final classification at the time of settlement decides the winner.',
  'Result corrections published by the official source before settlement replace the earlier result; after settlement, results are final and are not reversed.',
  'Disputed results are held; no settlement occurs while a dispute is open.',
  'Withholding is applied only where a rule for your jurisdiction is configured; it is shown on your settlement statement.',
];

/** Single place where pool status transitions happen (compare-and-set + history + audit). */
async function transition(c, poolId, from, to, actor, reason) {
  const froms = Array.isArray(from) ? from : [from];
  const { rows } = await c.query(`UPDATE pools SET status=$2 WHERE id=$1 AND status = ANY($3::text[]) RETURNING id`, [poolId, to, froms]);
  if (!rows[0]) {
    const cur = await c.query('SELECT status FROM pools WHERE id=$1', [poolId]);
    fail('INVALID_TRANSITION', `Pool cannot move to ${to} from ${cur.rows[0] ? cur.rows[0].status : 'missing'}`, 409);
  }
  await c.query(`INSERT INTO pool_status_history(pool_id, from_status, to_status, actor_type, actor_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`, [poolId, froms.join('|'), to, actor.type, actor.id ? String(actor.id) : null, reason || null]);
  await audit(c, { actorType: actor.type, actorId: actor.id, action: `pool.${to.toLowerCase()}`, targetType: 'pool', targetId: poolId, details: { reason } });
}

async function createEvent(admin, { name, kind, sport, startsAt, selections, officialSource, sourceEventRef }) {
  if (!['MATCH', 'TOURNAMENT'].includes(kind)) fail('INVALID_KIND', 'kind must be MATCH or TOURNAMENT');
  if (!Array.isArray(selections) || selections.length < 2) fail('INVALID_SELECTIONS', 'At least two selections are required');
  return tx(async (c) => {
    const { rows: [e] } = await c.query(`INSERT INTO events(name, kind, sport, starts_at, original_starts_at, official_source, source_event_ref)
      VALUES ($1,$2,$3,$4,$4,$5,$6) RETURNING *`, [name, kind, sport, startsAt, officialSource || results.SOURCE, sourceEventRef || `evt-${Date.now()}`]);
    for (const s of selections) {
      await c.query('INSERT INTO selections(event_id, code, label) VALUES ($1,$2,$3)', [e.id, s.code, s.label]);
    }
    await audit(c, { actorType: 'ADMIN', actorId: admin.id, action: 'event.created', targetType: 'event', targetId: e.id, details: { name, kind } });
    return e;
  });
}

async function createSponsor(admin, { name, kind = 'SPONSOR' }) {
  return tx(async (c) => {
    const { rows: [s] } = await c.query('INSERT INTO sponsors(name, kind) VALUES ($1,$2) RETURNING *', [name, kind]);
    await audit(c, { actorType: 'ADMIN', actorId: admin.id, action: 'sponsor.created', targetType: 'sponsor', targetId: s.id, details: { name, kind } });
    return s;
  });
}

async function createPool(admin, { eventId, name, entryAmountMinor = config.launch.defaultEntryMinor, feeBps = config.launch.defaultFeeBps,
  prizeBudgetMinor, sponsorId, entryDeadline, maxEntries = 10000, postponementWindowHours = 72 }) {
  if (!Number.isSafeInteger(prizeBudgetMinor) || prizeBudgetMinor <= 0) fail('INVALID_PRIZE', 'Prize budget must be a positive integer');
  const terms = econ.entryTerms({ entryAmountMinor, feeBps });
  return tx(async (c) => {
    const { rows: [ev] } = await c.query('SELECT * FROM events WHERE id=$1', [eventId]);
    if (!ev) fail('NOT_FOUND', 'Event not found', 404);
    if (new Date(entryDeadline) > new Date(ev.starts_at)) fail('DEADLINE_AFTER_START', 'Entry deadline must be at or before the event start');
    const { rows: [sp] } = await c.query('SELECT * FROM sponsors WHERE id=$1', [sponsorId]);
    if (!sp) fail('NOT_FOUND', 'Prize funder not found', 404);
    const { rows: sels } = await c.query('SELECT code, label FROM selections WHERE event_id=$1 ORDER BY code', [eventId]);
    const termsDoc = {
      rulesVersion: RULES_VERSION, model: 'REFUNDABLE', currency: config.launch.currency, fundsMode: config.payments.mode,
      depositMinor: terms.depositMinor, feeBps, feeBasis: config.launch.feeBasis, feeMinor: terms.feeMinor,
      refundableMinor: terms.refundableMinor, prizeBudgetMinor, prizeSource: sp.kind, prizeFunder: sp.name,
      withholdingRule: config.withholding.rule, withholdingBps: config.withholding.bps,
      entryDeadline: new Date(entryDeadline).toISOString(), officialSource: ev.official_source,
      postponementWindowHours, selections: sels, settlementRules: SETTLEMENT_RULES, oneEntryPerAccount: true,
    };
    const { rows: [p] } = await c.query(`INSERT INTO pools(event_id, name, currency, entry_amount_minor, fee_bps, fee_basis, fee_minor,
        refundable_minor, prize_budget_minor, prize_source, sponsor_id, withholding_rule, withholding_bps, entry_deadline, max_entries,
        postponement_window_hours, rules_version, terms, terms_hash, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [eventId, name, config.launch.currency, entryAmountMinor, feeBps, config.launch.feeBasis, terms.feeMinor, terms.refundableMinor,
        prizeBudgetMinor, sp.kind, sponsorId, config.withholding.rule, config.withholding.bps, entryDeadline, maxEntries,
        postponementWindowHours, RULES_VERSION, termsDoc, sha256(canonical(termsDoc)), admin.id]);
    await c.query(`INSERT INTO pool_status_history(pool_id, from_status, to_status, actor_type, actor_id) VALUES ($1,NULL,'DRAFT','ADMIN',$2)`, [p.id, admin.id]);
    await audit(c, { actorType: 'ADMIN', actorId: admin.id, action: 'pool.created', targetType: 'pool', targetId: p.id, details: { termsHash: p.terms_hash } });
    return p;
  });
}

/**
 * Fund the prize budget (simulated sponsor pay-in through MockPay), then allocate it into the
 * pool's escrow. Idempotent per pool.
 */
async function fundPrize(admin, poolId) {
  const { rows: [p0] } = await getPool().query('SELECT * FROM pools WHERE id=$1', [poolId]);
  if (!p0) fail('NOT_FOUND', 'Pool not found', 404);
  if (p0.status !== 'DRAFT') fail('INVALID_STATE', 'Prize funding is only accepted while the pool is in DRAFT', 409);
  const merchantRef = `prize-fund:${poolId}`;
  const providerPaymentId = `spn_${poolId.slice(0, 8)}_${Date.now()}`;
  await mockpay.completeCheckout({ providerPaymentId, merchantRef, amountMinor: p0.prize_budget_minor, currency: p0.currency });
  return tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM pools WHERE id=$1 FOR UPDATE', [poolId]);
    if (p.status !== 'DRAFT') fail('INVALID_STATE', 'Prize funding is only accepted while the pool is in DRAFT', 409);
    const sys = await ledger.systemAccounts(c, p.currency);
    const sponsorAcct = await ledger.account(c, { type: 'SPONSOR_AVAILABLE', currency: p.currency, sponsorId: p.sponsor_id });
    const escrow = await ledger.account(c, { type: 'POOL_PRIZE_ESCROW', currency: p.currency, poolId });
    const r1 = await ledger.post(c, { key: `prize-payin:${poolId}`, type: 'PRIZE_FUNDING_RECEIVED', currency: p.currency, poolId,
      description: `Prize funding received from funder (${merchantRef})`, createdBy: `admin:${admin.id}`,
      transfers: [{ from: sys.clearing, to: sponsorAcct, amountMinor: p.prize_budget_minor }] });
    const r2 = await ledger.post(c, { key: `prize-escrow:${poolId}`, type: 'PRIZE_ESCROWED', currency: p.currency, poolId,
      description: 'Prize budget allocated to pool escrow', createdBy: `admin:${admin.id}`,
      transfers: [{ from: sponsorAcct, to: escrow, amountMinor: p.prize_budget_minor }] });
    await audit(c, { actorType: 'ADMIN', actorId: admin.id, action: 'pool.prize_funded', targetType: 'pool', targetId: poolId,
      details: { amountMinor: p.prize_budget_minor, duplicate: r1.duplicate && r2.duplicate } });
    return { escrowMinor: await ledger.balance(c, escrow), duplicate: r1.duplicate && r2.duplicate };
  });
}

async function fundingCheck(c, p) {
  const escrow = await ledger.account(c, { type: 'POOL_PRIZE_ESCROW', currency: p.currency, poolId: p.id });
  const escrowMinor = await ledger.balance(c, escrow);
  return { escrowMinor, requiredMinor: p.prize_budget_minor, confirmed: escrowMinor >= p.prize_budget_minor };
}

async function openPool(admin, poolId) {
  return tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM pools WHERE id=$1 FOR UPDATE', [poolId]);
    if (!p) fail('NOT_FOUND', 'Pool not found', 404);
    const f = await fundingCheck(c, p);
    if (!f.confirmed) fail('PRIZE_NOT_FUNDED', `Prize funding not confirmed (${f.escrowMinor}/${f.requiredMinor})`, 409, f);
    const { rows: [{ late }] } = await c.query('SELECT $1::timestamptz <= clock_timestamp() AS late', [p.entry_deadline]);
    if (late) fail('DEADLINE_PASSED', 'Entry deadline already passed', 409);
    await transition(c, poolId, 'DRAFT', 'OPEN', { type: 'ADMIN', id: admin.id }, 'Prize funding confirmed');
    await c.query('UPDATE pools SET opened_at=now() WHERE id=$1', [poolId]);
    return { status: 'OPEN', funding: f };
  });
}

/** Worker job: lock pools whose deadline passed (entries are independently rejected by server time). */
async function lockDuePools() {
  const { rows } = await getPool().query(`SELECT id FROM pools WHERE status='OPEN' AND entry_deadline <= now()`);
  for (const r of rows) {
    await tx((c) => transition(c, r.id, 'OPEN', 'LOCKED', { type: 'SYSTEM' }, 'Entry deadline reached')).catch(() => {});
  }
  return rows.length;
}

async function cancelPool(actor, poolId, reason) {
  return tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM pools WHERE id=$1 FOR UPDATE', [poolId]);
    if (!p) fail('NOT_FOUND', 'Pool not found', 404);
    if (p.status === 'DRAFT') {
      // Nothing accepted yet: return any escrowed prize to the funder.
      await transition(c, poolId, 'DRAFT', 'CANCELLED', actor, reason);
    } else {
      await transition(c, poolId, ['OPEN', 'LOCKED', 'RESULT_REVIEW', 'DISPUTED', 'RESULT_CONFIRMED'], 'CANCELLED', actor, reason);
    }
    await enqueue(c, 'settlement.execute', { poolId }, `settle:${poolId}`);
    return { status: 'CANCELLED' };
  });
}

/** Postponement policy: within window → pool stays valid; beyond window → cancel with full refunds. */
async function postponeEvent(admin, eventId, newStartsAt) {
  const { rows: [ev] } = await getPool().query('SELECT * FROM events WHERE id=$1', [eventId]);
  if (!ev) fail('NOT_FOUND', 'Event not found', 404);
  const { rows: pools } = await getPool().query(`SELECT * FROM pools WHERE event_id=$1 AND status NOT IN ('SETTLING','SETTLED','REFUNDED','CANCELLED')`, [eventId]);
  await tx(async (c) => {
    await c.query(`UPDATE events SET starts_at=$2, status='POSTPONED' WHERE id=$1`, [eventId, newStartsAt]);
    await audit(c, { actorType: 'ADMIN', actorId: admin.id, action: 'event.postponed', targetType: 'event', targetId: eventId, details: { newStartsAt } });
  });
  const out = [];
  for (const p of pools) {
    const hours = (new Date(newStartsAt) - new Date(ev.original_starts_at)) / 3.6e6;
    if (hours > p.postponement_window_hours) {
      await cancelPool({ type: 'ADMIN', id: admin.id }, p.id, `Postponed ${hours.toFixed(1)}h beyond ${p.postponement_window_hours}h window`);
      out.push({ poolId: p.id, action: 'CANCELLED_FULL_REFUND' });
    } else out.push({ poolId: p.id, action: 'REMAINS_VALID' });
  }
  return out;
}

function publicPool(p, ev, sels, counts, myEntry) {
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    id: p.id, name: p.name, status: p.status, model: p.model, fundsMode: config.payments.mode,
    event: { id: ev.id, name: ev.name, kind: ev.kind, sport: ev.sport, startsAt: ev.starts_at, status: ev.status, officialSource: ev.official_source },
    currency: p.currency, entryDeadline: p.entry_deadline, serverTime: new Date().toISOString(),
    disclosure: {
      depositMinor: p.entry_amount_minor, feeMinor: p.fee_minor, feeBps: p.fee_bps, feeBasis: p.fee_basis,
      refundableMinor: p.refundable_minor, prizeBudgetMinor: p.prize_budget_minor, prizeSource: p.prize_source,
      withholdingRule: p.withholding_rule, withholdingBps: p.withholding_bps,
      youCanLose: `You can lose the platform fee (${econ.formatMinor(p.fee_minor, p.currency)}). There is no guaranteed profit.`,
    },
    selections: sels.map((s) => ({ id: s.id, code: s.code, label: s.label, picks: counts[s.id] || 0,
      bonusEstimate: econ.bonusEstimate({ prizeBudgetMinor: p.prize_budget_minor, currentPicks: counts[s.id] || 0, withholdingBps: p.withholding_bps }) })),
    entries: sum, maxEntries: p.max_entries,
    rulesVersion: p.rules_version, termsHash: p.terms_hash, settlementRules: p.terms.settlementRules,
    postponementWindowHours: p.postponement_window_hours,
    winningSelectionId: p.winning_selection_id, settlementOutcome: p.settlement_outcome, settlementReason: p.settlement_reason,
    myEntry: myEntry || null,
  };
}

async function getPublicPool(poolId, userId = null) {
  const db = getPool();
  const { rows: [p] } = await db.query('SELECT * FROM pools WHERE id=$1', [poolId]);
  if (!p || p.status === 'DRAFT') fail('NOT_FOUND', 'Pool not found', 404);
  const { rows: [ev] } = await db.query('SELECT * FROM events WHERE id=$1', [p.event_id]);
  const { rows: sels } = await db.query('SELECT * FROM selections WHERE event_id=$1 ORDER BY code', [p.event_id]);
  const { rows: cnt } = await db.query('SELECT selection_id, count(*)::int AS n FROM entries WHERE pool_id=$1 GROUP BY selection_id', [poolId]);
  let mine = null;
  if (userId) {
    const { rows } = await db.query('SELECT id, selection_id, status, accepted_at FROM entries WHERE pool_id=$1 AND user_id=$2', [poolId, userId]);
    mine = rows[0] ? { id: rows[0].id, selectionId: rows[0].selection_id, status: rows[0].status, acceptedAt: rows[0].accepted_at } : null;
  }
  return publicPool(p, ev, sels, Object.fromEntries(cnt.map((r) => [r.selection_id, r.n])), mine);
}

async function listPublicPools(userId = null) {
  const { rows } = await getPool().query(`SELECT id FROM pools WHERE status <> 'DRAFT' ORDER BY entry_deadline`);
  return Promise.all(rows.map((r) => getPublicPool(r.id, userId)));
}

module.exports = { RULES_VERSION, SETTLEMENT_RULES, transition, createEvent, createSponsor, createPool, fundPrize, fundingCheck,
  openPool, lockDuePools, cancelPool, postponeEvent, getPublicPool, listPublicPools };
