'use strict';
/**
 * End-to-end demo over the real HTTP API (simulated funds):
 * register → verify → fund → browse → enter → result → confirm → preview → settle → statement → withdraw → reconcile.
 * Usage: node scripts/demo.js   (reseeds the database)
 */
const { config } = require('../src/config');
const { seed } = require('./seed');
if (process.argv.includes('--yes')) config.db.allowReset = true;
const { closePool, getPool } = require('../src/db');
const { buildApp } = require('../src/http/app');
const { formatMinor } = require('../src/economics');

const fmt = (m) => formatMinor(m, 'USD');
let base;
async function call(method, path, { token, body, key } = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const step = (n, s) => console.log(`\n\x1b[1m${n}. ${s}\x1b[0m`);

(async () => {
  await seed();
  const server = buildApp().listen(0); base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    step(1, 'Register and complete eligibility checks');
    await call('POST', '/auth/register', { body: { email: 'demo.user@demo.test', password: 'demo-password', displayName: 'Dana Demo' } });
    const { token } = await call('POST', '/auth/login', { body: { email: 'demo.user@demo.test', password: 'demo-password' } });
    const v = await call('POST', '/me/verification', { token, body: { fullName: 'Dana Demo', dateOfBirth: '1992-06-15', documentNumber: 'X9876543', jurisdiction: 'DEMO' } });
    console.log('   verification:', v.status);

    step(2, 'Fund the account (simulated checkout → signed provider webhook → ledger credit)');
    const dep = await call('POST', '/wallet/deposits', { token, body: { amountMinor: 3000 }, key: 'demo-dep-1' });
    const cr = await call('POST', `/wallet/deposits/${dep.depositId}/simulate-checkout`, { token, body: {} });
    console.log('   webhook:', cr.status, '· balance', fmt((await call('GET', '/me', { token })).balances.availableMinor));

    step(3, 'Browse pools and read the disclosure');
    const pools = await call('GET', '/pools', { token });
    const pool = pools.find((p) => p.event.kind === 'MATCH');
    const d = pool.disclosure;
    console.log(`   ${pool.name} — deadline ${pool.entryDeadline}`);
    console.log(`   deposit ${fmt(d.depositMinor)} · fee ${fmt(d.feeMinor)} (${d.feeBps / 100}% of deposit) · refundable ${fmt(d.refundableMinor)} · prize budget ${fmt(d.prizeBudgetMinor)} (${d.prizeSource})`);
    console.log(`   ${d.youCanLose}`);
    for (const s of pool.selections) console.log(`   ${s.label}: ${s.picks} picks · estimated bonus if correct ≈ ${fmt(s.bonusEstimate.estimateGrossMinor)} (estimate)`);

    step(4, 'Choose a winner and confirm entry → receipt');
    const pick = pool.selections.find((s) => s.code === 'HOME');
    const rc = await call('POST', `/pools/${pool.id}/entries`, { token, key: 'demo-enter-1',
      body: { selectionId: pick.id, acceptedRulesVersion: pool.rulesVersion, acceptedTermsHash: pool.termsHash } });
    console.log(`   ${rc.receiptId}: ${rc.selection.label}, ${fmt(rc.depositMinor)} at ${new Date(rc.acceptedAt).toISOString()}, rules ${rc.rulesVersion} (${rc.termsHash.slice(0, 12)}…)`);
    const me = (await call('GET', '/me', { token })).balances;
    console.log(`   available ${fmt(me.availableMinor)} · locked ${fmt(me.lockedMinor)}`);

    step(5, 'Operations: sign in with MFA, publish official result, confirm, preview, settle');
    const { code } = await call('GET', '/demo/totp/ops@demo.test');
    const ops = (await call('POST', '/admin/auth/login', { body: { email: 'ops@demo.test', password: 'demo-password', totpCode: code } })).token;
    await call('POST', `/admin/events/${pool.event.id}/feed-result`, { token: ops, body: { outcomeType: 'WINNER', winningCode: 'HOME', isFinal: true } });
    await call('POST', `/admin/events/${pool.event.id}/ingest-result`, { token: ops });
    await call('POST', `/admin/pools/${pool.id}/confirm-result`, { token: ops });
    const pv = await call('GET', `/admin/pools/${pool.id}/settlement-preview`, { token: ops });
    console.log('   preview totals:', JSON.stringify(pv.totals));
    await call('POST', `/admin/pools/${pool.id}/settle`, { token: ops });

    step(6, 'Itemized settlement statement');
    const st = await call('GET', `/entries/${rc.entryId}/settlement`, { token });
    for (const i of st.items) console.log(`   ${i.label.padEnd(34)} ${fmt(i.amountMinor).padStart(14)}`);

    step(7, 'Withdraw (separate flow, simulated payout) and review history');
    const bal = (await call('GET', '/me', { token })).balances.availableMinor;
    await call('POST', '/wallet/withdrawals', { token, body: { amountMinor: bal }, key: 'demo-wd-1' });
    await call('POST', '/admin/worker/tick', { token: ops });
    console.log('   withdrawal:', (await call('GET', '/wallet/withdrawals', { token }))[0].status, '·', fmt(bal));
    for (const h of (await call('GET', '/wallet/transactions', { token })).slice(0, 8)) {
      console.log(`   ${h.type.padEnd(24)} ${h.account.padEnd(24)} ${fmt(h.amountMinor).padStart(12)}`);
    }

    step(8, 'Reconciliation & invariants');
    const rec = await call('GET', '/admin/reconciliation', { token: ops });
    for (const c of rec.invariants.checks) console.log(`   ${c.ok ? '✔' : '✘'} ${c.name}`);
    console.log(`   ${rec.provider.ok ? '✔' : '✘'} Provider books match ledger clearing (${fmt(rec.provider.providerNetMinor)})`);
    if (!rec.invariants.ok || !rec.provider.ok) process.exitCode = 1;
  } finally { server.close(); await closePool(); }
})().catch((e) => { console.error(e); process.exit(1); });
