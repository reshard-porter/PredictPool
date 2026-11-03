'use strict';
const outbox = require('./outbox');
const pools = require('./services/pools');
const settlement = require('./services/settlement');
const withdrawals = require('./services/withdrawals');

const handlers = {
  'settlement.execute': ({ poolId }) => settlement.execute({ type: 'SYSTEM', id: null }, poolId),
  'withdrawal.process': async ({ withdrawalId }) => { await withdrawals.processPayout(withdrawalId); },
  'notify.entry_receipt': async () => {},   // email/push adapter would go here
  'notify.pool_settled': async () => {},
};

async function tick(log) {
  await pools.lockDuePools();
  let n; do { n = await outbox.runOnce(handlers, { log }); } while (n > 0);
}

function start({ intervalMs = 500, log = console.log } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; running = true;
    try { await tick(log); } catch (e) { log('worker error', e.message); } finally { running = false; }
  }, intervalMs);
  return () => clearInterval(timer);
}

module.exports = { handlers, tick, start };

if (require.main === module) {
  require('./db').migrate().then(() => { console.log('worker started'); start(); });
}
