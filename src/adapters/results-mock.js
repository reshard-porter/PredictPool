'use strict';
/**
 * Simulated official results feed. In production this is replaced by the documented official
 * source named on each event (e.g. the governing body's published result). The operations
 * portal can "publish" a feed result for demo purposes.
 */
const { getPool } = require('../db');

const SOURCE = 'MockSportsFeed v1 (simulated official source)';

async function publish(sourceEventRef, { outcomeType, winningCode = null, isFinal = true, note = '' }) {
  const value = { outcomeType, winningCode, isFinal, note, publishedAt: new Date().toISOString() };
  await getPool().query(`INSERT INTO mock_provider_settings(key,value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [`result:${sourceEventRef}`, JSON.stringify(value)]);
  return value;
}

async function fetchResult(sourceEventRef) {
  const { rows } = await getPool().query('SELECT value FROM mock_provider_settings WHERE key=$1', [`result:${sourceEventRef}`]);
  if (!rows[0]) return null;
  return { source: SOURCE, sourceRef: `${sourceEventRef}@${rows[0].value.publishedAt}`, ...rows[0].value };
}

module.exports = { SOURCE, publish, fetchResult };
