'use strict';
const { sha256, canonical } = require('./crypto');

/**
 * Append to the hash-chained audit log. Must be called inside the same DB transaction as the
 * action it records. A table-level advisory lock serialises the chain.
 */
async function audit(client, { actorType, actorId, action, targetType, targetId, details = {} }) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('audit_log_chain'))");
  const { rows } = await client.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const prev = rows[0]?.hash || 'GENESIS';
  const at = new Date().toISOString();
  actorId = actorId ? String(actorId) : null; targetId = targetId ? String(targetId) : null; targetType = targetType || null;
  details = JSON.parse(JSON.stringify(details));
  const hash = sha256(canonical({ prev, actorType, actorId, action, targetType, targetId, details, at }));
  await client.query(
    `INSERT INTO audit_log(actor_type, actor_id, action, target_type, target_id, details, at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [actorType, actorId, action, targetType, targetId, details, at, prev, hash]);
}

async function verifyAuditChain(client) {
  const { rows } = await client.query('SELECT * FROM audit_log ORDER BY id');
  let prev = 'GENESIS';
  for (const r of rows) {
    const h = sha256(canonical({ prev, actorType: r.actor_type, actorId: r.actor_id, action: r.action,
      targetType: r.target_type, targetId: r.target_id, details: r.details, at: r.at.toISOString() }));
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
}

module.exports = { audit, verifyAuditChain };
