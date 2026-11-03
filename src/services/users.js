'use strict';
const { tx, getPool } = require('../db');
const { config } = require('../config');
const { fail } = require('../errors');
const { audit } = require('../audit');
const C = require('../crypto');
const kyc = require('../adapters/verification-mock');

async function register({ email, password, displayName }) {
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) fail('INVALID_EMAIL', 'A valid email is required');
  if (!password || password.length < 8) fail('WEAK_PASSWORD', 'Password must be at least 8 characters');
  return tx(async (c) => {
    const dup = await c.query('SELECT 1 FROM users WHERE lower(email)=lower($1)', [email]);
    if (dup.rowCount) fail('EMAIL_TAKEN', 'An account with this email already exists', 409);
    const { rows } = await c.query(
      `INSERT INTO users(email, password_hash, display_name, daily_deposit_limit_minor)
       VALUES ($1,$2,$3,$4) RETURNING id, email, display_name`,
      [email, C.hashPassword(password), displayName || email.split('@')[0], config.launch.defaultDailyDepositLimitMinor]);
    await audit(c, { actorType: 'USER', actorId: rows[0].id, action: 'user.registered', targetType: 'user', targetId: rows[0].id });
    return rows[0];
  });
}

async function createSession(c, subjectType, subjectId, mfaVerified = false) {
  const token = C.newToken();
  await c.query(`INSERT INTO sessions(token_hash, subject_type, subject_id, mfa_verified, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval)`,
    [C.sha256(token), subjectType, subjectId, mfaVerified, String(config.sessionTtlHours)]);
  return token;
}

async function login({ email, password }) {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
    if (!rows[0] || !C.verifyPassword(password || '', rows[0].password_hash)) fail('BAD_CREDENTIALS', 'Invalid email or password', 401);
    if (rows[0].status !== 'ACTIVE') fail('ACCOUNT_SUSPENDED', 'Account suspended', 403);
    return { token: await createSession(c, 'USER', rows[0].id), userId: rows[0].id };
  });
}

async function adminLogin({ email, password, totpCode }) {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM admins WHERE lower(email)=lower($1)', [email]);
    const a = rows[0];
    if (!a || !C.verifyPassword(password || '', a.password_hash)) fail('BAD_CREDENTIALS', 'Invalid credentials', 401);
    if (!C.verifyTotp(C.decryptPII(a.totp_secret_enc), String(totpCode || ''))) {
      await audit(c, { actorType: 'ADMIN', actorId: a.id, action: 'admin.mfa_failed' });
      fail('MFA_REQUIRED', 'A valid authenticator code is required', 401);
    }
    await audit(c, { actorType: 'ADMIN', actorId: a.id, action: 'admin.login' });
    return { token: await createSession(c, 'ADMIN', a.id, true), adminId: a.id, roles: a.roles };
  });
}

async function resolveSession(token) {
  if (!token) return null;
  const { rows } = await getPool().query('SELECT * FROM sessions WHERE token_hash=$1 AND expires_at > now()', [C.sha256(token)]);
  return rows[0] || null;
}

async function submitVerification(userId, { fullName, dateOfBirth, documentNumber, jurisdiction }) {
  const res = await kyc.verifyIdentity({ fullName, dateOfBirth, documentNumber, jurisdiction });
  return tx(async (c) => {
    await c.query(`INSERT INTO identity_records(user_id, full_name_enc, date_of_birth_enc, document_number_enc,
        document_last4, provider, provider_ref, decision, decision_reasons)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (user_id) DO UPDATE SET full_name_enc=EXCLUDED.full_name_enc, date_of_birth_enc=EXCLUDED.date_of_birth_enc,
        document_number_enc=EXCLUDED.document_number_enc, document_last4=EXCLUDED.document_last4,
        provider_ref=EXCLUDED.provider_ref, decision=EXCLUDED.decision, decision_reasons=EXCLUDED.decision_reasons, checked_at=now()`,
      [userId, C.encryptPII(fullName || ''), C.encryptPII(dateOfBirth || ''), C.encryptPII(documentNumber || ''),
        String(documentNumber || '').slice(-4), res.provider, res.providerRef, res.decision, JSON.stringify(res.reasons)]);
    await c.query('UPDATE users SET verification_status=$2, jurisdiction=$3 WHERE id=$1', [userId, res.decision, jurisdiction]);
    await audit(c, { actorType: 'USER', actorId: userId, action: 'user.verification', targetType: 'user', targetId: userId,
      details: { decision: res.decision, reasons: res.reasons, providerRef: res.providerRef } });
    return { status: res.decision, reasons: res.reasons };
  });
}

async function setSelfExclusion(userId, days) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) fail('INVALID_PERIOD', 'Choose between 1 and 3650 days');
  return tx(async (c) => {
    // Exclusion can only be extended, never shortened, before it expires.
    const { rows } = await c.query(`UPDATE users SET self_excluded_until = greatest(coalesce(self_excluded_until, now()), now() + ($2 || ' days')::interval)
      WHERE id=$1 RETURNING self_excluded_until`, [userId, String(days)]);
    await audit(c, { actorType: 'USER', actorId: userId, action: 'user.self_exclusion', targetType: 'user', targetId: userId, details: { days } });
    return { selfExcludedUntil: rows[0].self_excluded_until };
  });
}

async function setDepositLimit(userId, limitMinor) {
  if (!Number.isSafeInteger(limitMinor) || limitMinor < 0) fail('INVALID_LIMIT', 'Limit must be a non-negative integer');
  if (limitMinor > config.launch.defaultDailyDepositLimitMinor) fail('LIMIT_ABOVE_PLATFORM_MAX', 'Limit cannot exceed the platform maximum');
  return tx(async (c) => {
    await c.query('UPDATE users SET daily_deposit_limit_minor=$2 WHERE id=$1', [userId, limitMinor]);
    await audit(c, { actorType: 'USER', actorId: userId, action: 'user.deposit_limit', targetType: 'user', targetId: userId, details: { limitMinor } });
    return { dailyDepositLimitMinor: limitMinor };
  });
}

/** Eligibility gate used by deposits and entries. Withdrawals deliberately bypass self-exclusion. */
function assertEligible(user, purpose) {
  if (user.status !== 'ACTIVE') fail('ACCOUNT_SUSPENDED', 'Account is suspended', 403);
  if (user.verification_status !== 'VERIFIED') fail('NOT_VERIFIED', 'Complete identity and eligibility checks first', 403);
  if (!config.launch.eligibleJurisdictions.includes(user.jurisdiction)) fail('JURISDICTION_NOT_ELIGIBLE', 'Not available in your jurisdiction', 403);
  if (purpose !== 'WITHDRAW' && user.self_excluded_until && new Date(user.self_excluded_until) > new Date()) {
    fail('SELF_EXCLUDED', `Self-exclusion active until ${new Date(user.self_excluded_until).toISOString()}`, 403);
  }
}

async function profile(userId) {
  const { rows } = await getPool().query(
    `SELECT u.id, u.email, u.display_name, u.verification_status, u.jurisdiction, u.self_excluded_until,
            u.daily_deposit_limit_minor, i.document_last4
       FROM users u LEFT JOIN identity_records i ON i.user_id=u.id WHERE u.id=$1`, [userId]);
  const u = rows[0];
  return u && { id: u.id, email: u.email, displayName: u.display_name, verificationStatus: u.verification_status,
    jurisdiction: u.jurisdiction, selfExcludedUntil: u.self_excluded_until, dailyDepositLimitMinor: u.daily_deposit_limit_minor,
    documentMasked: u.document_last4 ? `••••${u.document_last4}` : null };
}

module.exports = { register, login, adminLogin, resolveSession, submitVerification, setSelfExclusion,
  setDepositLimit, assertEligible, profile, createSession };
