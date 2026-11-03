'use strict';
/**
 * MockPay — a simulated payment provider with its own books (tables `mock_provider_*`).
 * Behaviour mirrors a real PSP: checkouts produce signed webhooks; payouts are idempotent on
 * merchant_ref; failure modes can be injected for tests and demos.
 */
const crypto = require('crypto');
const { getPool } = require('../db');
const { config } = require('../config');
const { signWebhook } = require('../crypto');

const NAME = 'mockpay';
const id = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;

async function setting(key, fallback) {
  const { rows } = await getPool().query('SELECT value FROM mock_provider_settings WHERE key=$1', [key]);
  return rows[0] ? rows[0].value : fallback;
}
async function setSetting(key, value) {
  await getPool().query(`INSERT INTO mock_provider_settings(key,value) VALUES ($1,$2)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, JSON.stringify(value)]);
}

function createCheckout({ merchantRef, amountMinor, currency }) {
  if (config.payments.mode !== 'SIMULATED') require('../config').assertLivePaymentsAllowed();
  return { provider: NAME, providerPaymentId: id('pay'), merchantRef, amountMinor, currency,
    checkoutUrl: `/demo/checkout?merchantRef=${encodeURIComponent(merchantRef)}` };
}

/** Customer "pays" at the simulated checkout. Returns the signed webhook the provider would send. */
async function completeCheckout({ providerPaymentId, merchantRef, amountMinor, currency, succeed = true }) {
  const status = succeed ? 'SUCCEEDED' : 'FAILED';
  await getPool().query(`INSERT INTO mock_provider_transactions(id, kind, merchant_ref, amount_minor, currency, status)
    VALUES ($1,'PAYIN',$2,$3,$4,$5) ON CONFLICT (merchant_ref) DO NOTHING`, [providerPaymentId, merchantRef, amountMinor, currency, status]);
  return buildWebhook(succeed ? 'payment.succeeded' : 'payment.failed',
    { providerPaymentId, merchantRef, amountMinor, currency });
}

function buildWebhook(type, data, { eventId = id('evt'), t } = {}) {
  const body = JSON.stringify({ id: eventId, type, created: Math.floor(Date.now() / 1000), data });
  return { body, signature: signWebhook(body, config.payments.webhookSecret, t) };
}

class TransientProviderError extends Error { constructor(m) { super(m); this.transient = true; } }

/**
 * Payout. Failure injection via setting 'payout_mode':
 *   NORMAL | DECLINE (definitive failure) | TIMEOUT (nothing recorded, transient)
 *   | TIMEOUT_AFTER_COMMIT (provider records success but the response is lost)
 */
async function payout({ merchantRef, amountMinor, currency }) {
  const existing = await getPool().query('SELECT * FROM mock_provider_transactions WHERE merchant_ref=$1', [merchantRef]);
  if (existing.rows[0]) return { providerPayoutId: existing.rows[0].id, status: existing.rows[0].status, replayed: true };
  const mode = await setting('payout_mode', 'NORMAL');
  if (mode === 'TIMEOUT') throw new TransientProviderError('provider timeout');
  const status = mode === 'DECLINE' ? 'FAILED' : 'SUCCEEDED';
  const pid = id('po');
  await getPool().query(`INSERT INTO mock_provider_transactions(id, kind, merchant_ref, amount_minor, currency, status)
    VALUES ($1,'PAYOUT',$2,$3,$4,$5)`, [pid, merchantRef, amountMinor, currency, status]);
  if (mode === 'TIMEOUT_AFTER_COMMIT') throw new TransientProviderError('provider response lost');
  return { providerPayoutId: pid, status, failureReason: status === 'FAILED' ? 'BENEFICIARY_ACCOUNT_DECLINED' : null };
}

async function listTransactions() {
  const { rows } = await getPool().query('SELECT * FROM mock_provider_transactions ORDER BY created_at');
  return rows;
}

module.exports = { NAME, createCheckout, completeCheckout, buildWebhook, payout, listTransactions,
  setSetting, setting, TransientProviderError };
