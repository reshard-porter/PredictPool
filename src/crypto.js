'use strict';
const crypto = require('crypto');
const { config } = require('./config');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Canonical JSON (sorted keys) for hashing terms / payloads deterministically.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  if (!saltHex) return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

// AES-256-GCM envelope for identity data: v1:<iv>:<tag>:<ciphertext>
function encryptPII(plain) {
  const key = Buffer.from(config.piiKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function decryptPII(env) {
  const [, iv, tag, ct] = env.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(config.piiKeyHex, 'hex'), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) with ±1 step drift.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = ''; for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function newTotpSecret() {
  return Array.from(crypto.randomBytes(20)).map((b) => B32[b % 32]).join('');
}
function totp(secret, t = Date.now(), step = 0) {
  const counter = Math.floor(t / 1000 / 30) + step;
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  return code;
}
function verifyTotp(secret, code) {
  return [-1, 0, 1].some((s) => {
    const exp = totp(secret, Date.now(), s);
    return code && code.length === 6 && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(String(code)));
  });
}

// Provider webhook signature: header "t=<unix>,v1=<hex hmac(secret, `${t}.${body}`)>"
function signWebhook(body, secret, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${sig}`;
}
function verifyWebhook(body, header, secret, toleranceSec) {
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v1) return { ok: false, reason: 'MALFORMED_SIGNATURE' };
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return { ok: false, reason: 'TIMESTAMP_OUTSIDE_TOLERANCE' };
  const exp = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(exp); const b = Buffer.from(parts.v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_SIGNATURE' };
  return { ok: true };
}

const newToken = () => crypto.randomBytes(32).toString('base64url');

module.exports = { sha256, canonical, hashPassword, verifyPassword, encryptPII, decryptPII,
  newTotpSecret, totp, verifyTotp, signWebhook, verifyWebhook, newToken };
