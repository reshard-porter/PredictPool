'use strict';
/**
 * Create an operations administrator (for a database set up with db:migrate, without demo data).
 * Usage: npm run admin:create -- --email you@example.com --name "Your Name" [--roles OPS,RESULTS,FINANCE,AUDITOR]
 * Prints a generated password and an authenticator (TOTP) secret once. Store both safely.
 */
const crypto = require('crypto');
const { getPool, closePool, describeTarget, tx } = require('../src/db');
const C = require('../src/crypto');
const { audit } = require('../src/audit');

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : undefined; };

(async () => {
  const email = arg('email'); const name = arg('name') || email;
  const roles = (arg('roles') || 'OPS,RESULTS,FINANCE,AUDITOR').split(',').map((r) => r.trim().toUpperCase());
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('Usage: npm run admin:create -- --email you@example.com --name "Your Name"');
  const password = crypto.randomBytes(12).toString('base64url');
  const secret = C.newTotpSecret();
  console.log(`Creating admin on ${describeTarget().label}`);
  await tx(async (c) => {
    const { rows: [a] } = await c.query(`INSERT INTO admins(email, display_name, password_hash, totp_secret_enc, roles) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [email, name, C.hashPassword(password), C.encryptPII(secret), roles]);
    await audit(c, { actorType: 'SYSTEM', action: 'admin.created', targetType: 'admin', targetId: a.id, details: { email, roles } });
  });
  const label = encodeURIComponent(`PredictPool:${email}`);
  console.log(`\n  Email:      ${email}\n  Password:   ${password}\n  Roles:      ${roles.join(', ')}`);
  console.log(`  TOTP secret: ${secret}\n  Authenticator URI: otpauth://totp/${label}?secret=${secret}&issuer=PredictPool`);
  console.log('\nAdd the secret to an authenticator app (Google Authenticator, 1Password, …). This is shown only once.\n');
})().catch((e) => { console.error(e.code === '23505' ? 'An admin with that email already exists.' : e.message); process.exitCode = 1; })
  .finally(() => closePool());
