'use strict';
const path = require('path');

// Load settings from .env (repo root) if present. Variables already set in the shell win.
// ENV_FILE picks another file; ENV_FILE="" disables loading (the test suite does this).
const envFile = process.env.ENV_FILE ?? path.join(__dirname, '..', '.env');
if (envFile && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// Central configuration. Every jurisdiction-specific value is an explicit placeholder:
// the MVP refuses live payments until these are supplied and approved.
const env = process.env;

const config = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/predictpool',

  // Hosted databases (e.g. filess.io): either DATABASE_URL or the DB_* fields below.
  db: {
    host: env.DB_HOST || null, port: Number(env.DB_PORT || 5432), name: env.DB_NAME || null,
    user: env.DB_USER || null, password: env.DB_PASSWORD || null,
    schema: env.DB_SCHEMA || null,                     // schema for the app's tables; created if missing
    ssl: (env.DB_SSL || 'off').toLowerCase(),          // off | require | no-verify
    sslCa: env.DB_SSL_CA || null,                      // path to a CA certificate (with DB_SSL=require)
    poolMax: Number(env.DB_POOL_MAX || 20),            // shared free tiers allow only a few connections
    idleTimeoutMs: Number(env.DB_IDLE_TIMEOUT_MS || 10000),
    connectTimeoutMs: Number(env.DB_CONNECT_TIMEOUT_MS || 10000),
    allowReset: env.ALLOW_DB_RESET === '1',
  },

  launch: {
    jurisdiction: env.LAUNCH_JURISDICTION || null,          // [COUNTRY/REGION] — not supplied
    currency: env.CURRENCY || 'USD',                        // [CURRENCY] — demo default, SIMULATED funds
    currencyExponent: Number(env.CURRENCY_EXPONENT || 2),
    defaultEntryMinor: Number(env.ENTRY_AMOUNT_MINOR || 1000),   // [AMOUNT] — demo 10.00
    defaultFeeBps: Number(env.FEE_BPS || 500),              // [PERCENTAGE] — demo 5% of deposit
    feeBasis: 'PERCENT_OF_DEPOSIT_ROUND_HALF_UP',            // [CALCULATION BASIS]
    minimumAge: Number(env.MIN_AGE || 18),                  // placeholder until jurisdiction supplied
    eligibleJurisdictions: (env.ELIGIBLE_JURISDICTIONS || 'DEMO').split(','),
    defaultDailyDepositLimitMinor: Number(env.DAILY_DEPOSIT_LIMIT_MINOR || 50000),
    maxBalanceMinor: Number(env.MAX_BALANCE_MINOR || 500000),
  },

  // Withholding is never invented. A rule must be configured per jurisdiction with legal sign-off.
  withholding: { rule: 'NONE_CONFIGURED', bps: 0 },

  payments: {
    mode: 'SIMULATED',                 // 'LIVE' is refused by assertLivePaymentsAllowed()
    provider: 'mockpay',
    webhookSecret: env.MOCKPAY_WEBHOOK_SECRET || 'whsec_demo_only_change_me',
    webhookToleranceSeconds: 300,
  },

  // AES-256-GCM key for identity data (32 bytes hex). Demo key only.
  piiKeyHex: env.PII_KEY_HEX || '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0',
  sessionTtlHours: 12,
  disputeWindowSeconds: Number(env.DISPUTE_WINDOW_SECONDS || 0),
  workerPollMs: Number(env.WORKER_POLL_MS || 500),
  demoMode: env.DEMO_MODE !== 'false',
};

function assertLivePaymentsAllowed() {
  const missing = [];
  if (!config.launch.jurisdiction) missing.push('launch jurisdiction');
  missing.push('payment provider approval', 'custody arrangements', 'applicable tax rules');
  throw new Error(`LIVE_PAYMENTS_DISABLED: supply and approve ${missing.join(', ')}`);
}

module.exports = { config, assertLivePaymentsAllowed };
