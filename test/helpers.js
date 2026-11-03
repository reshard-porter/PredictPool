'use strict';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/predictpool_test';
process.env.DISPUTE_WINDOW_SECONDS = '0';
// Tests erase the database on every run, so they only ever use the test URL above — never the
// DATABASE_URL / DB_* settings from .env — and they refuse anything that isn't local.
process.env.ENV_FILE = '';
for (const k of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_SCHEMA']) delete process.env[k];
process.env.DB_SSL = process.env.TEST_DB_SSL || 'off';
process.env.DB_POOL_MAX = process.env.TEST_DB_POOL_MAX || '20';
{
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && process.env.ALLOW_REMOTE_TEST_DB !== '1') {
    throw new Error(`Tests reset the database; refusing non-local TEST_DATABASE_URL host "${host}". Set ALLOW_REMOTE_TEST_DB=1 to override.`);
  }
}

const { migrate, getPool, closePool } = require('../src/db');
const C = require('../src/crypto');
const pools = require('../src/services/pools');
const users = require('../src/services/users');
const wallet = require('../src/services/wallet');
const entries = require('../src/services/entries');
const results = require('../src/services/results');
const settlement = require('../src/services/settlement');
const ledger = require('../src/ledger');
const mockpay = require('../src/adapters/payments-mock');

let n = 0;
const ctx = {};

async function reset() {
  await migrate({ reset: true });
  const { rows: [a] } = await getPool().query(`INSERT INTO admins(email, display_name, password_hash, totp_secret_enc, roles)
    VALUES ('ops@test','Ops',$1,$2,ARRAY['OPS','RESULTS','FINANCE','AUDITOR']) RETURNING *`, [C.hashPassword('pw-pw-pw-pw'), C.encryptPII(C.newTotpSecret())]);
  ctx.admin = a;
  ctx.sponsor = await pools.createSponsor(a, { name: 'Test Sponsor' });
  await mockpay.setSetting('payout_mode', 'NORMAL');
  return ctx;
}

async function makeUser(balanceMinor = 0) {
  n++;
  const u = await users.register({ email: `u${n}_${Date.now()}@t.test`, password: 'password123', displayName: `User ${n}` });
  await users.submitVerification(u.id, { fullName: `User Number ${n}`, dateOfBirth: '1990-01-01', documentNumber: `DOC${100000 + n}`, jurisdiction: 'DEMO' });
  if (balanceMinor > 0) {
    const d = await wallet.createDeposit(u.id, balanceMinor);
    await wallet.simulateCheckout(u.id, d.depositId);
  }
  return u;
}

async function makePool({ entry = 1000, feeBps = 500, prize = 10000, deadlineMs = 3600e3, selections = ['HOME', 'AWAY'], open = true, fund = true } = {}) {
  n++;
  const ev = await pools.createEvent(ctx.admin, { name: `Event ${n}`, kind: 'MATCH', sport: 'Test', startsAt: new Date(Date.now() + deadlineMs + 3600e3).toISOString(),
    sourceEventRef: `src-${n}-${Date.now()}`, selections: selections.map((c) => ({ code: c, label: c })) });
  const p = await pools.createPool(ctx.admin, { eventId: ev.id, name: `Pool ${n}`, entryAmountMinor: entry, feeBps, prizeBudgetMinor: prize,
    sponsorId: ctx.sponsor.id, entryDeadline: new Date(Date.now() + deadlineMs).toISOString() });
  if (fund) await pools.fundPrize(ctx.admin, p.id);
  if (open) await pools.openPool(ctx.admin, p.id);
  const { rows: sels } = await getPool().query('SELECT * FROM selections WHERE event_id=$1', [ev.id]);
  return { pool: p, event: ev, sel: Object.fromEntries(sels.map((s) => [s.code, s.id])) };
}

async function enter(user, P, code) {
  const pub = await getPool().query('SELECT rules_version, terms_hash FROM pools WHERE id=$1', [P.pool.id]);
  return entries.enter(user.id, P.pool.id, { selectionId: P.sel[code], acceptedRulesVersion: pub.rows[0].rules_version, acceptedTermsHash: pub.rows[0].terms_hash });
}

/** Close entries, record + confirm a result. */
async function finish(P, outcome) {
  await results.recordResult(ctx.admin, P.event.id, { source: P.event.official_source, sourceRef: 'test', isFinal: true, ...outcome });
  return results.confirmResult(ctx.admin, P.pool.id);
}

async function bal(userId) { return wallet.balances(userId); }

async function accountTotal(type, poolId = null) {
  const { rows: [r] } = await getPool().query(`SELECT coalesce(sum(balance_minor),0)::bigint b FROM account_balances WHERE type=$1 AND ($2::uuid IS NULL OR pool_id=$2)`, [type, poolId]);
  return r.b;
}

module.exports = { ctx, reset, makeUser, makePool, enter, finish, bal, accountTotal, closePool, getPool,
  pools, users, wallet, entries, results, settlement, ledger, mockpay };
