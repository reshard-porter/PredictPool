'use strict';
/** HTTP-level journey: funding → prediction → settlement → simulated withdrawal, plus API idempotency and admin MFA/RBAC. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const C = require('../src/crypto');
const { buildApp } = require('../src/http/app');
const recon = require('../src/services/reconciliation');

let server; let base;
test.before(async () => {
  await H.reset();
  await H.getPool().query(`INSERT INTO admins(email, display_name, password_hash, totp_secret_enc, roles) VALUES
    ('auditor@test','Aud',$1,$2,ARRAY['AUDITOR'])`, [C.hashPassword('pw-pw-pw-pw'), C.encryptPII(C.newTotpSecret())]);
  server = buildApp().listen(0); base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => { server.close(); await H.closePool(); });

async function call(method, path, { token, body, headers = {} } = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function adminToken(email) {
  const { body: { code } } = await call('GET', `/demo/totp/${email}`);
  const r = await call('POST', '/admin/auth/login', { body: { email, password: 'pw-pw-pw-pw', totpCode: code } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.token;
}

test('admin endpoints require MFA and role', async () => {
  const noMfa = await call('POST', '/admin/auth/login', { body: { email: 'ops@test', password: 'pw-pw-pw-pw', totpCode: '000000' } });
  assert.equal(noMfa.status, 401);
  const aud = await adminToken('auditor@test');
  const P = await H.makePool();
  const r = await call('POST', `/admin/pools/${P.pool.id}/settle`, { token: aud });
  assert.equal(r.status, 403);
  const audit = await call('GET', '/admin/audit', { token: aud });
  assert.equal(audit.status, 200);
});

test('full journey over HTTP with idempotent entry', async () => {
  const ops = await adminToken('ops@test');
  const P = await H.makePool({ entry: 1000, feeBps: 500, prize: 10000 });
  const other = await H.makeUser(1000); await H.enter(other, P, 'AWAY');

  await call('POST', '/auth/register', { body: { email: 'journey@test.test', password: 'password123', displayName: 'Jay' } });
  const { body: { token } } = await call('POST', '/auth/login', { body: { email: 'journey@test.test', password: 'password123' } });
  assert.equal((await call('POST', '/me/verification', { token, body: { fullName: 'Jay Journey', dateOfBirth: '1991-02-03', documentNumber: 'P1234567', jurisdiction: 'DEMO' } })).body.status, 'VERIFIED');

  const dep = await call('POST', '/wallet/deposits', { token, body: { amountMinor: 2000 }, headers: { 'idempotency-key': 'dep-1' } });
  assert.equal(dep.status, 201);
  assert.equal((await call('POST', `/wallet/deposits/${dep.body.depositId}/simulate-checkout`, { token, body: {} })).body.status, 'credited');

  const pool = (await call('GET', `/pools/${P.pool.id}`, { token })).body;
  assert.equal(pool.disclosure.feeMinor, 50);
  assert.equal(pool.disclosure.refundableMinor, 950);
  assert.equal(pool.disclosure.prizeBudgetMinor, 10000);
  assert.match(pool.disclosure.youCanLose, /lose the platform fee/);
  const home = pool.selections.find((s) => s.code === 'HOME');
  assert.equal(home.bonusEstimate.isEstimate, true);

  const req = { selectionId: home.id, acceptedRulesVersion: pool.rulesVersion, acceptedTermsHash: pool.termsHash };
  const [e1, e2] = await Promise.all([
    call('POST', `/pools/${P.pool.id}/entries`, { token, body: req, headers: { 'idempotency-key': 'enter-1' } }),
    call('POST', `/pools/${P.pool.id}/entries`, { token, body: req, headers: { 'idempotency-key': 'enter-1' } })]);
  assert.ok([e1.status, e2.status].includes(201));
  const replay = await call('POST', `/pools/${P.pool.id}/entries`, { token, body: req, headers: { 'idempotency-key': 'enter-1' } });
  assert.equal(replay.status, 201); assert.equal(replay.headers.get('idempotent-replay'), 'true');
  const receipt = replay.body;
  assert.ok(receipt.receiptId && receipt.acceptedAt && receipt.rulesVersion && receipt.selection.code === 'HOME');
  const reused = await call('POST', `/pools/${P.pool.id}/entries`, { token, body: { ...req, selectionId: 'x' }, headers: { 'idempotency-key': 'enter-1' } });
  assert.equal(reused.status, 422);
  assert.equal((await call('GET', '/me', { token })).body.balances.lockedMinor, 1000);

  // Ops: result → confirm → preview → settle
  await H.results.recordResult(H.ctx.admin, P.event.id, { source: P.event.official_source, sourceRef: 'api', outcomeType: 'WINNER', winningCode: 'HOME', isFinal: true });
  assert.equal((await call('POST', `/admin/pools/${P.pool.id}/confirm-result`, { token: ops })).status, 200);
  const prev = await call('GET', `/admin/pools/${P.pool.id}/settlement-preview`, { token: ops });
  assert.equal(prev.body.totals.bonusGrossMinor, 10000);
  assert.equal((await call('POST', `/admin/pools/${P.pool.id}/settle`, { token: ops })).status, 202);

  const st = await call('GET', `/entries/${receipt.entryId}/settlement`, { token });
  assert.equal(st.body.items.find((i) => i.total).amountMinor, 10950);
  const me = (await call('GET', '/me', { token })).body.balances;
  assert.equal(me.availableMinor, 1000 + 10950);

  const wd = await call('POST', '/wallet/withdrawals', { token, body: { amountMinor: 11950 }, headers: { 'idempotency-key': 'wd-1' } });
  assert.equal(wd.status, 202);
  await call('POST', '/admin/worker/tick', { token: ops });
  const list = (await call('GET', '/wallet/withdrawals', { token })).body;
  assert.equal(list[0].status, 'PAID');
  assert.equal((await call('GET', '/me', { token })).body.balances.availableMinor, 0);

  const rec = await call('GET', '/admin/reconciliation', { token: ops });
  assert.ok(rec.body.invariants.ok && rec.body.provider.ok, JSON.stringify(rec.body));
});

test('webhook endpoint rejects unsigned calls', async () => {
  const r = await fetch(base.replace('/api', '') + '/webhooks/payments/mockpay', { method: 'POST', body: '{"id":"x"}' });
  assert.equal(r.status, 401);
});
