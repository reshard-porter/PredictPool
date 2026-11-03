'use strict';
/**
 * Transactional outbox. enqueue() is called inside the business transaction, so a message exists
 * iff the state change committed. Workers claim rows with FOR UPDATE SKIP LOCKED and a lease, so
 * multiple workers can run safely; handlers must be idempotent (they are: every financial effect
 * is keyed in the ledger).
 */
const { getPool } = require('./db');

const MAX_ATTEMPTS = 8;

async function enqueue(c, topic, payload, dedupeKey = null) {
  await c.query(`INSERT INTO outbox(topic, payload, dedupe_key) VALUES ($1,$2,$3) ON CONFLICT (dedupe_key) DO NOTHING`,
    [topic, payload, dedupeKey]);
}

async function claim(limit = 10) {
  const { rows } = await getPool().query(
    `UPDATE outbox SET attempts = attempts + 1, available_at = now() + interval '30 seconds'
      WHERE id IN (SELECT id FROM outbox WHERE status='PENDING' AND available_at <= now()
                   ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1)
      RETURNING *`, [limit]);
  return rows;
}

async function runOnce(handlers, { log = () => {} } = {}) {
  const msgs = await claim();
  for (const m of msgs) {
    const h = handlers[m.topic];
    try {
      if (h) await h(m.payload, m);
      await getPool().query(`UPDATE outbox SET status='DONE', processed_at=now(), last_error=NULL WHERE id=$1`, [m.id]);
    } catch (err) {
      const dead = m.attempts >= MAX_ATTEMPTS || (err && err.transient === false);
      const backoffSec = Math.min(2 ** m.attempts, 300);
      await getPool().query(`UPDATE outbox SET status=$2, last_error=$3, available_at = now() + ($4 || ' seconds')::interval WHERE id=$1`,
        [m.id, dead ? 'DEAD' : 'PENDING', String(err && err.message), String(backoffSec)]);
      log(`outbox ${m.topic}#${m.id} failed (attempt ${m.attempts}): ${err && err.message}`);
    }
  }
  return msgs.length;
}

module.exports = { enqueue, runOnce, claim, MAX_ATTEMPTS };
