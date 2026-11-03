'use strict';
const { tx, getPool } = require('../db');
const { config } = require('../config');
const { fail } = require('../errors');
const { audit } = require('../audit');
const feed = require('../adapters/results-mock');
const { transition } = require('./pools');

const REVIEWABLE = ['LOCKED', 'RESULT_REVIEW', 'DISPUTED', 'RESULT_CONFIRMED'];

/**
 * Record a result version for an event from its documented official source.
 * Pools that are LOCKED (or OPEN past deadline) move to RESULT_REVIEW. A new version received
 * before settlement (a correction) sends confirmed pools back to review.
 */
async function ingestFromFeed(admin, eventId) {
  const { rows: [ev] } = await getPool().query('SELECT * FROM events WHERE id=$1', [eventId]);
  if (!ev) fail('NOT_FOUND', 'Event not found', 404);
  const r = await feed.fetchResult(ev.source_event_ref);
  if (!r) fail('NO_RESULT_PUBLISHED', 'The official source has not published a result yet', 409);
  return recordResult(admin, eventId, r);
}

async function recordResult(admin, eventId, { outcomeType, winningCode, isFinal = true, source, sourceRef, note }) {
  if (!['WINNER', 'TIE', 'NO_RESULT'].includes(outcomeType)) fail('INVALID_OUTCOME', 'outcomeType must be WINNER, TIE or NO_RESULT');
  return tx(async (c) => {
    const { rows: [ev] } = await c.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [eventId]);
    if (source !== ev.official_source) fail('UNOFFICIAL_SOURCE', `Results must come from the documented official source: ${ev.official_source}`);
    let winId = null;
    if (outcomeType === 'WINNER') {
      const { rows: [s] } = await c.query('SELECT id FROM selections WHERE event_id=$1 AND code=$2', [eventId, winningCode]);
      if (!s) fail('INVALID_SELECTION', `Unknown selection code ${winningCode}`);
      winId = s.id;
    }
    const { rows: [{ v }] } = await c.query('SELECT coalesce(max(version),0)+1 AS v FROM results WHERE event_id=$1', [eventId]);
    const { rows: [res] } = await c.query(`INSERT INTO results(event_id, version, outcome_type, winning_selection_id, source, source_ref, is_final, raw, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [eventId, v, outcomeType, winId, source, sourceRef || 'manual', isFinal, { outcomeType, winningCode, isFinal, note }, admin.id]);
    if (isFinal) await c.query(`UPDATE events SET status='FINISHED' WHERE id=$1`, [eventId]);
    await audit(c, { actorType: 'ADMIN', actorId: admin.id, action: v > 1 ? 'result.corrected' : 'result.recorded',
      targetType: 'event', targetId: eventId, details: { version: v, outcomeType, winningCode, isFinal, source, sourceRef } });

    const affected = [];
    const { rows: pools } = await c.query('SELECT * FROM pools WHERE event_id=$1 FOR UPDATE', [eventId]);
    for (const p of pools) {
      if (['DRAFT', 'CANCELLED'].includes(p.status)) continue;
      if (['SETTLING', 'SETTLED', 'REFUNDED'].includes(p.status)) {
        await audit(c, { actorType: 'SYSTEM', action: 'result.post_settlement_correction_ignored', targetType: 'pool', targetId: p.id,
          details: { version: v, policy: 'Settled results are final; no reversal. Escalate to operator for discretionary goodwill.' } });
        continue;
      }
      if (p.status === 'OPEN') await transition(c, p.id, 'OPEN', 'LOCKED', { type: 'SYSTEM' }, 'Result received; entries closed');
      if (['LOCKED', 'RESULT_CONFIRMED'].includes(p.status) || p.status === 'OPEN') {
        await transition(c, p.id, ['LOCKED', 'RESULT_CONFIRMED'], 'RESULT_REVIEW', { type: 'ADMIN', id: admin.id },
          v > 1 ? `Result correction v${v} received` : `Result v${v} received`);
      }
      await c.query('UPDATE pools SET winning_selection_id=NULL WHERE id=$1', [p.id]);
      affected.push(p.id);
    }
    return { resultId: res.id, version: v, affectedPools: affected };
  });
}

async function latestResult(c, eventId) {
  const { rows } = await c.query('SELECT * FROM results WHERE event_id=$1 ORDER BY version DESC LIMIT 1', [eventId]);
  return rows[0] || null;
}

/** Confirm the latest final result for a pool. Blocked while disputes are open. */
async function confirmResult(admin, poolId) {
  return tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM pools WHERE id=$1 FOR UPDATE', [poolId]);
    if (!p) fail('NOT_FOUND', 'Pool not found', 404);
    if (p.status !== 'RESULT_REVIEW') fail('INVALID_STATE', `Pool is ${p.status}; result can only be confirmed from RESULT_REVIEW`, 409);
    const open = await c.query(`SELECT 1 FROM disputes WHERE pool_id=$1 AND status='OPEN'`, [poolId]);
    if (open.rowCount) fail('DISPUTE_OPEN', 'Resolve open disputes before confirming', 409);
    const r = await latestResult(c, p.event_id);
    if (!r || !r.is_final) fail('RESULT_NOT_FINAL', 'The official result is not final yet', 409);
    const { rows: [{ ok }] } = await c.query(`SELECT $1::timestamptz + ($2 || ' seconds')::interval <= now() AS ok`, [r.recorded_at, String(config.disputeWindowSeconds)]);
    if (!ok) fail('DISPUTE_WINDOW_OPEN', 'The dispute window has not elapsed', 409);
    await c.query('UPDATE pools SET winning_selection_id=$2 WHERE id=$1', [poolId, r.winning_selection_id]);
    await transition(c, poolId, 'RESULT_REVIEW', 'RESULT_CONFIRMED', { type: 'ADMIN', id: admin.id }, `Confirmed result v${r.version} (${r.outcome_type})`);
    return { status: 'RESULT_CONFIRMED', resultVersion: r.version, outcomeType: r.outcome_type };
  });
}

async function raiseDispute(actor, poolId, reason) {
  if (!reason || reason.trim().length < 5) fail('REASON_REQUIRED', 'Please describe the issue');
  return tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM pools WHERE id=$1 FOR UPDATE', [poolId]);
    if (!p) fail('NOT_FOUND', 'Pool not found', 404);
    if (actor.type === 'USER') {
      const e = await c.query('SELECT 1 FROM entries WHERE pool_id=$1 AND user_id=$2', [poolId, actor.id]);
      if (!e.rowCount) fail('NOT_A_PARTICIPANT', 'Only participants can dispute a result', 403);
    }
    if (!['RESULT_REVIEW', 'RESULT_CONFIRMED', 'DISPUTED'].includes(p.status)) fail('INVALID_STATE', `Disputes are accepted only before settlement (pool is ${p.status})`, 409);
    const { rows: [d] } = await c.query(`INSERT INTO disputes(pool_id, raised_by_type, raised_by_id, reason) VALUES ($1,$2,$3,$4) RETURNING *`,
      [poolId, actor.type, actor.id, reason]);
    if (p.status !== 'DISPUTED') await transition(c, poolId, ['RESULT_REVIEW', 'RESULT_CONFIRMED'], 'DISPUTED', actor, 'Dispute raised; settlement held');
    await c.query('UPDATE pools SET winning_selection_id=NULL WHERE id=$1', [poolId]);
    await audit(c, { actorType: actor.type, actorId: actor.id, action: 'dispute.raised', targetType: 'dispute', targetId: d.id, details: { poolId, reason } });
    return d;
  });
}

/** Resolve a dispute. UPHELD expects ops to record a corrected result (or cancel); either way review resumes. */
async function resolveDispute(admin, disputeId, { decision, note }) {
  if (!['UPHELD', 'REJECTED'].includes(decision)) fail('INVALID_DECISION', 'decision must be UPHELD or REJECTED');
  return tx(async (c) => {
    const { rows: [d] } = await c.query(`SELECT * FROM disputes WHERE id=$1 FOR UPDATE`, [disputeId]);
    if (!d || d.status !== 'OPEN') fail('NOT_FOUND', 'Open dispute not found', 404);
    await c.query(`UPDATE disputes SET status=$2, resolution_note=$3, resolved_by=$4, resolved_at=now() WHERE id=$1`, [disputeId, decision, note || '', admin.id]);
    await audit(c, { actorType: 'ADMIN', actorId: admin.id, action: 'dispute.resolved', targetType: 'dispute', targetId: disputeId, details: { decision, note } });
    const still = await c.query(`SELECT 1 FROM disputes WHERE pool_id=$1 AND status='OPEN'`, [d.pool_id]);
    const { rows: [p] } = await c.query('SELECT status FROM pools WHERE id=$1 FOR UPDATE', [d.pool_id]);
    if (!still.rowCount && p.status === 'DISPUTED') await transition(c, d.pool_id, 'DISPUTED', 'RESULT_REVIEW', { type: 'ADMIN', id: admin.id }, `Dispute ${decision.toLowerCase()}`);
    return { status: decision };
  });
}

module.exports = { ingestFromFeed, recordResult, confirmResult, raiseDispute, resolveDispute, latestResult, REVIEWABLE };
