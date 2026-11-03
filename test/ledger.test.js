'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { tx } = require('../src/db');

test.before(H.reset);
test.after(H.closePool);

test('database rejects an unbalanced transaction at commit', async () => {
  const u = await H.makeUser(1000);
  await assert.rejects(tx(async (c) => {
    const a = await H.ledger.account(c, { type: 'USER_AVAILABLE', currency: 'USD', userId: u.id });
    const { rows: [t] } = await c.query(`INSERT INTO ledger_transactions(idempotency_key,type,description,payload_hash,created_by) VALUES ('bad1','X','x','h','test') RETURNING id`);
    await c.query(`INSERT INTO postings(transaction_id, account_id, currency, amount_minor) VALUES ($1,$2,'USD',500)`, [t.id, a]);
  }), /LEDGER_UNBALANCED/);
});

test('postings, transactions and audit records cannot be updated or deleted', async () => {
  const db = H.getPool();
  await assert.rejects(db.query('UPDATE postings SET amount_minor = amount_minor + 1'), /IMMUTABLE/);
  await assert.rejects(db.query('DELETE FROM postings'), /IMMUTABLE/);
  await assert.rejects(db.query('DELETE FROM ledger_transactions'), /IMMUTABLE/);
  await assert.rejects(db.query('UPDATE audit_log SET action = $1', ['tamper']), /IMMUTABLE/);
  await assert.rejects(db.query('TRUNCATE audit_log'), /IMMUTABLE/);
});

test('overdraft of a customer account is rejected by the database', async () => {
  const u = await H.makeUser(500);
  await assert.rejects(tx(async (c) => {
    const ua = await H.ledger.userAccounts(c, u.id, 'USD');
    await H.ledger.post(c, { key: 'od1', type: 'T', description: 't', currency: 'USD', createdBy: 'test',
      transfers: [{ from: ua.available, to: ua.pendingWithdrawal, amountMinor: 501 }] });
  }), /LEDGER_OVERDRAFT/);
});

test('ledger posting is idempotent by key; key reuse with different content is refused', async () => {
  const u = await H.makeUser(1000);
  const run = (amt) => tx(async (c) => {
    const ua = await H.ledger.userAccounts(c, u.id, 'USD');
    return H.ledger.post(c, { key: 'idem-1', type: 'T', description: 't', currency: 'USD', createdBy: 'test',
      transfers: [{ from: ua.available, to: ua.pendingWithdrawal, amountMinor: amt }] });
  });
  const a = await run(100); const b = await run(100);
  assert.equal(a.txnId, b.txnId); assert.equal(b.duplicate, true);
  assert.equal((await H.bal(u.id)).pendingWithdrawalMinor, 100);
  await assert.rejects(run(200), /IDEMPOTENCY_CONFLICT|reused/);
});

test('financial terms are frozen once a pool opens', async () => {
  const P = await H.makePool();
  await assert.rejects(H.getPool().query('UPDATE pools SET fee_bps=900 WHERE id=$1', [P.pool.id]), /POOL_TERMS_FROZEN/);
  await assert.rejects(H.getPool().query(`UPDATE pools SET entry_deadline=now()+interval '9 days' WHERE id=$1`, [P.pool.id]), /POOL_TERMS_FROZEN/);
});

test('a pool cannot open without confirmed prize funding', async () => {
  await assert.rejects(H.makePool({ fund: false }), /PRIZE_NOT_FUNDED|Prize funding not confirmed/);
});

test('prize funding is idempotent (double click does not double-fund)', async () => {
  const P = await H.makePool({ open: false });
  const again = await H.pools.fundPrize(H.ctx.admin, P.pool.id);
  assert.equal(again.duplicate, true);
  assert.equal(again.escrowMinor, 10000);
});
