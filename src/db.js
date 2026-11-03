'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { config } = require('./config');

// BIGINT -> JS number is safe for our ranges (< 2^53 minor units); guard anyway.
require('pg').types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint out of safe range: ${v}`);
  return n;
});

const SSL_PARAMS = ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat'];

/** Build pg Pool options from DATABASE_URL or DB_* fields, plus SSL and pool sizing. */
function poolOptions() {
  const { db } = config;
  const opts = {
    max: db.poolMax,
    idleTimeoutMillis: db.idleTimeoutMs,
    connectionTimeoutMillis: db.connectTimeoutMs,
    keepAlive: true,
    application_name: 'predictpool',
  };
  if (db.host) {
    Object.assign(opts, { host: db.host, port: db.port, database: db.name, user: db.user, password: db.password });
  } else {
    let url = config.databaseUrl;
    // An sslmode in the URL would override DB_SSL inside pg, so DB_SSL takes the decision alone.
    if (db.ssl !== 'off') {
      const u = new URL(url);
      SSL_PARAMS.forEach((k) => u.searchParams.delete(k));
      url = u.toString();
    }
    opts.connectionString = url;
  }
  if (db.schema) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(db.schema)) {
      throw new Error(`DB_SCHEMA must use lowercase letters, digits and underscores, starting with a letter (got "${db.schema}")`);
    }
    opts.options = `-c search_path=${db.schema}`;   // every pooled connection works in this schema
  }
  if (db.ssl === 'require') opts.ssl = { rejectUnauthorized: true, ...(db.sslCa ? { ca: fs.readFileSync(db.sslCa, 'utf8') } : {}) };
  else if (db.ssl === 'no-verify') opts.ssl = { rejectUnauthorized: false };
  else if (db.ssl !== 'off') throw new Error(`DB_SSL must be off, require or no-verify (got "${db.ssl}")`);
  return opts;
}

/** Where we're connected, without the password. */
function describeTarget() {
  const { db } = config;
  let host; let port; let name; let user;
  if (db.host) ({ host, port, name, user } = db);
  else {
    const u = new URL(config.databaseUrl);
    host = u.hostname; port = u.port || 5432; name = u.pathname.replace(/^\//, ''); user = decodeURIComponent(u.username);
  }
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(host) || String(host).startsWith('/');
  const schema = db.schema ? `, schema: ${db.schema}` : '';
  return { host, port: Number(port), database: name, user, ssl: db.ssl, local, label: `${user}@${host}:${port}/${name} (ssl: ${db.ssl}${schema})` };
}

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool(poolOptions());
    // A hosted server may drop idle connections; without this handler the process would crash.
    pool.on('error', (err) => console.error(`[db] idle connection error: ${err.message}`));
  }
  return pool;
}
async function closePool() { if (pool) { await pool.end(); pool = null; } }

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock

/** Run fn inside a transaction; retries on serialization/deadlock errors. */
async function tx(fn, { isolation = 'READ COMMITTED', retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (RETRYABLE.has(err.code) && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Drop this app's objects from the current schema. Unlike DROP SCHEMA public, this needs only
 * ownership of our own tables, which is all a shared host usually grants.
 */
const RESET_SQL = `
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = current_schema() AND c.relkind IN ('v','m') AND pg_has_role(c.relowner, 'USAGE')
  LOOP EXECUTE format('DROP VIEW IF EXISTS %s CASCADE', r.obj); END LOOP;
  FOR r IN SELECT c.oid::regclass AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = current_schema() AND c.relkind IN ('r','p') AND pg_has_role(c.relowner, 'USAGE')
  LOOP EXECUTE format('DROP TABLE IF EXISTS %s CASCADE', r.obj); END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = current_schema() AND pg_has_role(p.proowner, 'USAGE')
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.fn); END LOOP;
  -- Legacy layout (before v0.2) kept the simulated provider in its own schema.
  BEGIN EXECUTE 'DROP SCHEMA IF EXISTS mockprovider CASCADE'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;`;

/** Make sure there is a schema to create tables in (hosted databases may have no usable "public"). */
async function ensureSchema(p) {
  const { schema } = config.db;
  if (schema) {
    try { await p.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`); }
    catch (e) {
      if (e.code === '42501') throw new Error(`Your database user may not create schema "${schema}". Run "npm run db:check" to see which schemas you can use, and set DB_SCHEMA to one of them.`);
      throw e;
    }
    return;
  }
  const { rows: [r] } = await p.query('SELECT current_schema() AS s');
  if (!r.s) {
    throw new Error('Your database user has no default schema to create tables in. Add DB_SCHEMA=predictpool to .env (the app creates it), then run this again. "npm run db:check" lists the options.');
  }
}

async function migrate({ reset = false } = {}) {
  const p = getPool();
  await ensureSchema(p);
  if (reset) {
    const target = describeTarget();
    if (!target.local && !config.db.allowReset) {
      throw new Error(`Refusing to reset remote database ${target.label}. Re-run with --yes (or ALLOW_DB_RESET=1) to erase it.`);
    }
    await p.query(RESET_SQL);
  }
  await p.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const applied = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const { rowCount } = await p.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
    if (rowCount) continue;
    await tx(async (c) => {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}

module.exports = { getPool, closePool, tx, migrate, describeTarget, poolOptions };
