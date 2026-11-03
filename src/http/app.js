'use strict';
const path = require('path');
const express = require('express');
const { getPool, tx } = require('../db');
const { config } = require('../config');
const { AppError, fail } = require('../errors');
const { sha256, canonical, decryptPII, totp } = require('../crypto');
const { audit } = require('../audit');
const users = require('../services/users');
const wallet = require('../services/wallet');
const pools = require('../services/pools');
const entries = require('../services/entries');
const results = require('../services/results');
const settlement = require('../services/settlement');
const withdrawals = require('../services/withdrawals');
const recon = require('../services/reconciliation');
const mockpay = require('../adapters/payments-mock');
const feed = require('../adapters/results-mock');
const worker = require('../worker');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => { if (!res.headersSent) res.json(out); }).catch(next);
const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;

async function auth(req, _res, next) {
  try { req.session = await users.resolveSession(bearer(req)); next(); } catch (e) { next(e); }
}
const requireUser = (req, _res, next) => (req.session && req.session.subject_type === 'USER'
  ? (req.userId = req.session.subject_id, next()) : next(new AppError('UNAUTHENTICATED', 'Sign in required', 401)));

function requireAdmin(...roles) {
  return async (req, _res, next) => {
    try {
      const s = req.session;
      if (!s || s.subject_type !== 'ADMIN' || !s.mfa_verified) fail('UNAUTHENTICATED', 'Administrator sign-in with MFA required', 401);
      const { rows: [a] } = await getPool().query('SELECT id, email, display_name, roles FROM admins WHERE id=$1', [s.subject_id]);
      if (roles.length && !roles.some((r) => a.roles.includes(r))) fail('FORBIDDEN', `Requires role: ${roles.join(' or ')}`, 403);
      req.admin = a; next();
    } catch (e) { next(e); }
  };
}

/** Idempotency-Key handling: same key + same body replays the stored response; different body is rejected. */
function idempotent(endpoint) {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) return next(new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required', 400));
    const subject = req.userId || (req.admin && req.admin.id);
    const h = sha256(canonical({ endpoint, params: req.params, body: req.body }));
    try {
      const ins = await getPool().query(`INSERT INTO idempotency_keys(subject_id, key, endpoint, request_hash) VALUES ($1,$2,$3,$4)
        ON CONFLICT DO NOTHING RETURNING key`, [subject, key, endpoint, h]);
      if (!ins.rowCount) {
        const { rows: [r] } = await getPool().query('SELECT * FROM idempotency_keys WHERE subject_id=$1 AND key=$2', [subject, key]);
        if (r.request_hash !== h) return next(new AppError('IDEMPOTENCY_KEY_REUSED', 'Key was used with a different request', 422));
        if (r.response_status === null) return next(new AppError('REQUEST_IN_PROGRESS', 'An identical request is still processing', 409));
        res.set('Idempotent-Replay', 'true');
        return res.status(r.response_status).json(r.response_body);
      }
      const json = res.json.bind(res);
      res.json = (body) => {
        const status = res.statusCode;
        const persist = status < 500
          ? getPool().query('UPDATE idempotency_keys SET response_status=$3, response_body=$4 WHERE subject_id=$1 AND key=$2', [subject, key, status, body])
          : getPool().query('DELETE FROM idempotency_keys WHERE subject_id=$1 AND key=$2', [subject, key]);
        persist.finally(() => json(body));
        return res;
      };
      next();
    } catch (e) { next(e); }
  };
}

/** CORS for the Expo web build / dev tools. Native apps do not need it. Allow-list via CORS_ORIGINS. */
function cors(req, res, next) {
  const origin = req.get('origin');
  const allowed = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes(origin) || (config.demoMode && /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?$/.test(origin)));
  if (ok) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'authorization, content-type, idempotency-key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.set('Access-Control-Expose-Headers', 'idempotent-replay');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(ok ? 204 : 403);
  next();
}

function buildApp({ runWorkerInline = true } = {}) {
  const app = express();
  app.use(cors);
  // Raw body for webhook signature verification must be captured before JSON parsing.
  app.post('/webhooks/payments/mockpay', express.text({ type: '*/*' }), wrap(async (req) =>
    wallet.handleWebhook(req.body, req.get('mockpay-signature'))));
  app.use(express.json({ limit: '100kb' }));
  app.use(auth);
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  const api = express.Router();
  // ── public & auth
  api.get('/config', wrap(async () => ({ currency: config.launch.currency, exponent: config.launch.currencyExponent,
    fundsMode: config.payments.mode, jurisdiction: config.launch.jurisdiction || 'NOT CONFIGURED (demo)', demoMode: config.demoMode,
    withholdingRule: config.withholding.rule })));
  api.post('/auth/register', wrap(async (req) => users.register(req.body)));
  api.post('/auth/login', wrap(async (req) => users.login(req.body)));
  api.post('/admin/auth/login', wrap(async (req) => users.adminLogin(req.body)));
  api.get('/pools', wrap(async (req) => pools.listPublicPools(req.session && req.session.subject_type === 'USER' ? req.session.subject_id : null)));
  api.get('/pools/:id', wrap(async (req) => pools.getPublicPool(req.params.id, req.session && req.session.subject_type === 'USER' ? req.session.subject_id : null)));

  // ── user
  api.get('/me', requireUser, wrap(async (req) => ({ profile: await users.profile(req.userId), balances: await wallet.balances(req.userId) })));
  api.post('/me/verification', requireUser, wrap(async (req) => users.submitVerification(req.userId, req.body)));
  api.post('/me/self-exclusion', requireUser, wrap(async (req) => users.setSelfExclusion(req.userId, Number(req.body.days))));
  api.put('/me/limits', requireUser, wrap(async (req) => users.setDepositLimit(req.userId, Number(req.body.dailyDepositLimitMinor))));
  api.get('/me/entries', requireUser, wrap(async (req) => entries.myEntries(req.userId)));
  api.post('/pools/:id/entries', requireUser, idempotent('enter'), wrap(async (req, res) => {
    const r = await entries.enter(req.userId, req.params.id, req.body); res.status(201); return r;
  }));
  api.get('/entries/:id/receipt', requireUser, wrap(async (req) => entries.receipt(req.userId, req.params.id)));
  api.get('/entries/:id/settlement', requireUser, wrap(async (req) => settlement.statement(req.userId, req.params.id)));
  api.post('/pools/:id/disputes', requireUser, wrap(async (req, res) => {
    const d = await results.raiseDispute({ type: 'USER', id: req.userId }, req.params.id, req.body.reason); res.status(201); return d;
  }));
  api.post('/wallet/deposits', requireUser, idempotent('deposit'), wrap(async (req, res) => {
    const r = await wallet.createDeposit(req.userId, Number(req.body.amountMinor)); res.status(201); return r;
  }));
  api.post('/wallet/deposits/:id/simulate-checkout', requireUser, wrap(async (req) => {
    if (!config.demoMode) fail('NOT_AVAILABLE', 'Simulated checkout is available in demo mode only', 404);
    const r = await wallet.simulateCheckout(req.userId, req.params.id, { succeed: req.body.succeed !== false });
    return r.result;
  }));
  api.post('/wallet/withdrawals', requireUser, idempotent('withdraw'), wrap(async (req, res) => {
    const r = await withdrawals.request(req.userId, Number(req.body.amountMinor)); res.status(202); return r;
  }));
  api.get('/wallet/withdrawals', requireUser, wrap(async (req) => withdrawals.list(req.userId)));
  api.get('/wallet/transactions', requireUser, wrap(async (req) => wallet.history(req.userId)));

  // ── operations
  const ops = requireAdmin('OPS'); const res_ = requireAdmin('RESULTS'); const fin = requireAdmin('FINANCE');
  const anyAdmin = requireAdmin();
  api.get('/admin/me', anyAdmin, wrap(async (req) => req.admin));
  api.get('/admin/overview', anyAdmin, wrap(async () => {
    const db = getPool();
    const { rows: ps } = await db.query(`SELECT p.*, e.name AS event_name, e.status AS event_status, e.source_event_ref, e.official_source,
        (SELECT count(*)::int FROM entries x WHERE x.pool_id=p.id) AS entry_count,
        (SELECT coalesce(sum(balance_minor),0)::bigint FROM account_balances b WHERE b.pool_id=p.id AND b.type='POOL_PRIZE_ESCROW') AS escrow_minor,
        (SELECT coalesce(sum(balance_minor),0)::bigint FROM account_balances b WHERE b.pool_id=p.id AND b.type='USER_LOCKED') AS locked_minor
      FROM pools p JOIN events e ON e.id=p.event_id ORDER BY p.created_at DESC`);
    const { rows: evs } = await db.query(`SELECT e.*, (SELECT json_agg(json_build_object('id',s.id,'code',s.code,'label',s.label) ORDER BY s.code) FROM selections s WHERE s.event_id=e.id) AS selections FROM events e ORDER BY starts_at`);
    const { rows: sps } = await db.query('SELECT * FROM sponsors ORDER BY created_at');
    const { rows: ds } = await db.query(`SELECT d.*, p.name AS pool_name FROM disputes d JOIN pools p ON p.id=d.pool_id ORDER BY d.created_at DESC`);
    const { rows: wd } = await db.query(`SELECT w.*, u.email FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.created_at DESC LIMIT 50`);
    const { rows: rs } = await db.query(`SELECT r.*, s.code AS winning_code FROM results r LEFT JOIN selections s ON s.id=r.winning_selection_id ORDER BY recorded_at DESC`);
    const { rows: ob } = await db.query(`SELECT status, count(*)::int n FROM outbox GROUP BY 1`);
    return { pools: ps, events: evs, sponsors: sps, disputes: ds, withdrawals: wd, results: rs, outbox: ob, totals: await recon.platformTotals(),
      payoutMode: await mockpay.setting('payout_mode', 'NORMAL') };
  }));
  api.post('/admin/sponsors', ops, wrap(async (req) => pools.createSponsor(req.admin, req.body)));
  api.post('/admin/events', ops, wrap(async (req) => pools.createEvent(req.admin, req.body)));
  api.post('/admin/events/:id/postpone', ops, wrap(async (req) => pools.postponeEvent(req.admin, req.params.id, req.body.newStartsAt)));
  api.post('/admin/pools', ops, wrap(async (req) => pools.createPool(req.admin, req.body)));
  api.post('/admin/pools/:id/fund-prize', fin, wrap(async (req) => pools.fundPrize(req.admin, req.params.id)));
  api.get('/admin/pools/:id/funding', anyAdmin, wrap(async (req) => {
    const { rows: [p] } = await getPool().query('SELECT * FROM pools WHERE id=$1', [req.params.id]);
    return tx((c) => pools.fundingCheck(c, p));
  }));
  api.post('/admin/pools/:id/open', ops, wrap(async (req) => pools.openPool(req.admin, req.params.id)));
  api.post('/admin/pools/:id/cancel', ops, wrap(async (req) => pools.cancelPool({ type: 'ADMIN', id: req.admin.id }, req.params.id, req.body.reason || 'Cancelled by operations')));
  api.post('/admin/events/:id/feed-result', res_, wrap(async (req) => {
    if (!config.demoMode) fail('NOT_AVAILABLE', 'Demo only', 404);
    const { rows: [ev] } = await getPool().query('SELECT * FROM events WHERE id=$1', [req.params.id]);
    const r = await feed.publish(ev.source_event_ref, req.body);
    await tx((c) => audit(c, { actorType: 'ADMIN', actorId: req.admin.id, action: 'demo.feed_published', targetType: 'event', targetId: ev.id, details: r }));
    return r;
  }));
  api.post('/admin/events/:id/ingest-result', res_, wrap(async (req) => results.ingestFromFeed(req.admin, req.params.id)));
  api.post('/admin/pools/:id/confirm-result', res_, wrap(async (req) => results.confirmResult(req.admin, req.params.id)));
  api.post('/admin/pools/:id/disputes', res_, wrap(async (req) => results.raiseDispute({ type: 'ADMIN', id: req.admin.id }, req.params.id, req.body.reason)));
  api.post('/admin/disputes/:id/resolve', res_, wrap(async (req) => results.resolveDispute(req.admin, req.params.id, req.body)));
  api.get('/admin/pools/:id/settlement-preview', anyAdmin, wrap(async (req) => settlement.preview(req.params.id)));
  api.post('/admin/pools/:id/settle', fin, wrap(async (req, res) => {
    const r = await settlement.requestSettlement(req.admin, req.params.id);
    if (runWorkerInline) await worker.tick(() => {});
    res.status(202); return r;
  }));
  api.get('/admin/audit', requireAdmin('AUDITOR', 'OPS'), wrap(async (req) => {
    const { rows } = await getPool().query(`SELECT * FROM audit_log ORDER BY id DESC LIMIT $1`, [Math.min(Number(req.query.limit) || 200, 1000)]);
    return rows;
  }));
  api.get('/admin/reconciliation', requireAdmin('FINANCE', 'AUDITOR'), wrap(async () => ({
    invariants: await recon.invariants(), provider: await recon.providerReconciliation() })));
  api.get('/admin/users/:id/identity', requireAdmin('OPS'), wrap(async (req) => {
    // Protected identity access: always audited; full values only with an explicit reason.
    const { rows: [r] } = await getPool().query('SELECT * FROM identity_records WHERE user_id=$1', [req.params.id]);
    if (!r) fail('NOT_FOUND', 'No identity record', 404);
    const reveal = Boolean(req.query.reason);
    await tx((c) => audit(c, { actorType: 'ADMIN', actorId: req.admin.id, action: reveal ? 'pii.revealed' : 'pii.viewed_masked', targetType: 'user', targetId: req.params.id, details: { reason: req.query.reason || null } }));
    return { decision: r.decision, documentMasked: `••••${r.document_last4}`, checkedAt: r.checked_at,
      ...(reveal ? { fullName: decryptPII(r.full_name_enc), dateOfBirth: decryptPII(r.date_of_birth_enc) } : {}) };
  }));
  api.post('/admin/mock/payout-mode', fin, wrap(async (req) => {
    await mockpay.setSetting('payout_mode', req.body.mode);
    await tx((c) => audit(c, { actorType: 'ADMIN', actorId: req.admin.id, action: 'demo.payout_mode', details: { mode: req.body.mode } }));
    return { mode: req.body.mode };
  }));
  api.post('/admin/worker/tick', anyAdmin, wrap(async () => { await worker.tick(() => {}); return { ok: true }; }));

  // Demo-only authenticator so reviewers can sign in to ops without a phone. Disabled outside demo mode.
  api.get('/demo/totp/:email', wrap(async (req) => {
    if (!config.demoMode) fail('NOT_AVAILABLE', 'Demo only', 404);
    const { rows: [a] } = await getPool().query('SELECT totp_secret_enc FROM admins WHERE email=$1', [req.params.email]);
    if (!a) fail('NOT_FOUND', 'Unknown admin', 404);
    return { code: totp(decryptPII(a.totp_secret_enc)), note: 'DEMO ONLY — simulated authenticator app' };
  }));

  app.use('/api', api);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err && err.code === '23505') return res.status(409).json({ error: { code: 'CONFLICT', message: 'Duplicate request' } });
    if (err && typeof err.message === 'string' && /POOL_TERMS_FROZEN|LEDGER_|IMMUTABLE/.test(err.message)) {
      return res.status(409).json({ error: { code: err.message.split(':')[0], message: err.message } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error' } });
  });
  return app;
}

module.exports = { buildApp };
