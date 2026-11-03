'use strict';
/**
 * Check that the configured database (DATABASE_URL or DB_* in .env) can run PredictPool.
 * Read-only: every probe runs inside a transaction that is rolled back.
 * Usage: npm run db:check
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { getPool, closePool, describeTarget } = require('../src/db');

const results = [];
const ok = (name, detail = '') => results.push({ s: 'ok', name, detail });
const warn = (name, detail) => results.push({ s: 'warn', name, detail });
const bad = (name, detail) => results.push({ s: 'fail', name, detail });

function hintFor(err) {
  const m = String(err.message || err);
  if (err.code === 'ENOTFOUND') return 'The host name was not found. Copy the host exactly from your provider dashboard.';
  if (err.code === 'ECONNREFUSED') return 'Nothing is listening on that host/port. Check DB_PORT (hosted Postgres often uses a non-default port).';
  if (err.code === 'ETIMEDOUT' || /timeout/i.test(m)) return 'Connection timed out. Check the host/port, and that your network allows outbound connections on that port.';
  if (err.code === '28P01') return 'Wrong user name or password.';
  if (err.code === '3D000') return 'That database name does not exist. Use the database name shown in your provider dashboard.';
  if (err.code === '53300') return 'Too many connections: the provider’s connection limit is used up. Stop other clients (other app instances, SQL editors) and lower DB_POOL_MAX.';
  if (/self[- ]signed|unable to verify|certificate/i.test(m)) return 'The server’s SSL certificate could not be verified. Set DB_SSL=no-verify, or DB_SSL=require with DB_SSL_CA pointing to the provider’s CA file.';
  if (/does not support SSL/i.test(m)) return 'The server does not accept SSL. Set DB_SSL=off.';
  if (/no pg_hba\.conf entry.*no encryption|SSL.*required|requires? SSL/i.test(m)) return 'The server requires SSL. Set DB_SSL=require (or no-verify).';
  return null;
}

async function probe(c, name, sql, onFail) {
  await c.query('SAVEPOINT p');
  try { await c.query(sql); await c.query('RELEASE SAVEPOINT p'); ok(name); return true; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT p'); bad(name, `${e.message}${onFail ? ` — ${onFail}` : ''}`); return false; }
}

(async () => {
  const target = describeTarget();
  console.log(`\nChecking ${target.label}\n`);
  if (!target.local && target.ssl === 'off') warn('SSL', 'DB_SSL=off for a remote server: credentials and data travel unencrypted. Try DB_SSL=require (or no-verify).');

  const pool = getPool();
  let c;
  const t0 = Date.now();
  try {
    c = await pool.connect();
    ok('Connect', `${Date.now() - t0} ms`);
  } catch (e) {
    const h = hintFor(e);
    bad('Connect', `${e.message}${h ? `\n    → ${h}` : ''}`);
    return finish();
  }

  try {
    const { rows: [v] } = await c.query(`SELECT current_setting('server_version') AS v, current_setting('server_version_num')::int AS n,
      current_user AS u, current_database() AS d, current_schema() AS s`);
    if (v.n >= 130000) ok('PostgreSQL version', v.v);
    else warn('PostgreSQL version', `${v.v}: below 13, so the pgcrypto extension is needed for gen_random_uuid().`);
    // Where tables will go. With DB_SCHEMA the app creates its own schema if needed.
    const { rows: [priv] } = await c.query(`SELECT has_database_privilege(current_database(), 'CREATE') AS can_create_schema,
      (SELECT string_agg(nspname, ', ' ORDER BY nspname) FROM pg_namespace
        WHERE has_schema_privilege(nspname, 'CREATE') AND nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema') AS usable`);
    const want = config.db.schema;
    if (want) {
      const exists = (await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [want])).rowCount > 0;
      if (exists) ok('Schema for tables', `${want} (exists)`);
      else if (priv.can_create_schema) ok('Schema for tables', `${want} (will be created by db:migrate / seed)`);
      else bad('Schema for tables', `${want} does not exist and your user may not create schemas. Usable schemas: ${priv.usable || 'none'}. Set DB_SCHEMA to one of them, or ask the provider.`);
    } else if (!v.s) {
      bad('Schema for tables', `none — your user has no default schema. ${priv.can_create_schema
        ? 'Add DB_SCHEMA=predictpool to .env; the app will create it.'
        : `Set DB_SCHEMA to a schema you can use: ${priv.usable || 'none found — ask the provider'}.`}`);
    } else ok('Schema for tables', v.s);
    ok('Signed in', `user ${v.u}, database ${v.d}`);

    const ssl = await c.query('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()').catch(() => ({ rows: [] }));
    if (ssl.rows[0]) (ssl.rows[0].ssl ? ok('Encryption', `SSL in use (${ssl.rows[0].version})`) : (target.local ? ok('Encryption', 'not used (local)') : warn('Encryption', 'connection is NOT encrypted')));

    // Connection limits: the smallest of server, role and database limits applies to us.
    const { rows: [lim] } = await c.query(`SELECT current_setting('max_connections')::int AS server,
      (SELECT rolconnlimit FROM pg_roles WHERE rolname = current_user) AS role_limit,
      (SELECT datconnlimit FROM pg_database WHERE datname = current_database()) AS db_limit,
      (SELECT count(*)::int FROM pg_stat_activity WHERE usename = current_user) AS in_use`);
    const limits = [lim.server, lim.role_limit, lim.db_limit].filter((x) => x >= 0);
    const effective = Math.min(...limits);
    const needed = config.db.poolMax;
    const detail = `limit ${effective} (server ${lim.server}, role ${lim.role_limit < 0 ? 'none' : lim.role_limit}, database ${lim.db_limit < 0 ? 'none' : lim.db_limit}); ${lim.in_use} in use now; DB_POOL_MAX=${needed}`;
    if (needed >= effective) warn('Connection limit', `${detail}. Set DB_POOL_MAX to ${Math.max(1, effective - 1)} or lower so a SQL editor can still connect.`);
    else ok('Connection limit', detail);

    // Privileges the migration needs, probed in a transaction that is always rolled back.
    await c.query('BEGIN');
    if (want) await probe(c, 'Create schema', `CREATE SCHEMA IF NOT EXISTS ${want}`, 'your user lacks CREATE on the database; set DB_SCHEMA to an existing schema');
    const tbl = 'pp_dbcheck_probe';
    const created = await probe(c, 'Create tables', `CREATE TABLE ${tbl} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), n bigint)`,
      'your user needs CREATE privilege on the schema (on PostgreSQL 15+, only the database owner has it on "public" by default)');
    await probe(c, 'Generate UUIDs (gen_random_uuid)', 'SELECT gen_random_uuid()');
    await probe(c, 'Create PL/pgSQL functions', `CREATE FUNCTION pp_dbcheck_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    if (created) {
      await probe(c, 'Create triggers', `CREATE TRIGGER pp_dbcheck_t BEFORE UPDATE ON ${tbl} FOR EACH ROW EXECUTE FUNCTION pp_dbcheck_fn()`);
      await probe(c, 'Create deferred constraint triggers', `CREATE CONSTRAINT TRIGGER pp_dbcheck_ct AFTER INSERT ON ${tbl} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pp_dbcheck_fn()`);
      await probe(c, 'Create views', `CREATE VIEW pp_dbcheck_v AS SELECT * FROM ${tbl}`);
      await probe(c, 'Row locks with SKIP LOCKED', `SELECT * FROM ${tbl} FOR UPDATE SKIP LOCKED`);
    }
    await probe(c, 'Advisory locks', `SELECT pg_advisory_xact_lock(hashtext('pp_dbcheck'))`);
    await c.query('ROLLBACK');

    // Storage. Providers may count the whole database (system catalogs included) or only your tables.
    const { rows: [sz] } = await c.query(`SELECT pg_database_size(current_database())::bigint AS db,
      coalesce((SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = current_schema() AND c.relkind IN ('r','m','p')), 0)::bigint AS app`);
    const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
    const limitMb = Number(process.env.DB_STORAGE_LIMIT_MB || (/filess\.io$/i.test(target.host) ? 10 : 0));
    const sDetail = `this app's tables ${mb(sz.app)}; whole database incl. system catalogs ${mb(sz.db)}`;
    const cap = limitMb * 1048576;
    if (limitMb && sz.app > cap * 0.8) warn('Storage', `${sDetail}; your data is over 80% of the ${limitMb} MB plan limit`);
    else if (limitMb && sz.db > cap * 0.8) warn('Storage', `${sDetail}. Your data fits the ${limitMb} MB limit, but if the provider counts the whole database (an empty one is ~7.5 MB) you are near it. Check usage in the provider dashboard, and avoid repeated full reseeds (each adds ~0.5 MB of catalog overhead).`);
    else ok('Storage', `${sDetail}${limitMb ? ` (plan limit ${limitMb} MB)` : ''}`);

    // Migration status.
    const files = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    const has = await c.query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS t`);
    const applied = has.rows[0].t ? (await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name) : [];
    const pending = files.filter((f) => !applied.includes(f));
    if (!pending.length) ok('Schema', `up to date (${applied.length} migration${applied.length === 1 ? '' : 's'})`);
    else warn('Schema', `${pending.length} pending: ${pending.join(', ')}. Run "npm run db:migrate", or "npm run seed -- --yes" for demo data.`);
    const legacy = await c.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'mockprovider'`);
    if (legacy.rowCount) warn('Legacy layout', 'schema "mockprovider" from an older version exists. Run "npm run seed" (local) to rebuild.');

    // Round-trip latency matters for a remote database: every request makes several queries.
    const times = [];
    for (let i = 0; i < 5; i++) { const t = Date.now(); await c.query('SELECT 1'); times.push(Date.now() - t); }
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    (avg > 150 ? warn : ok)('Latency', `${avg} ms per query on average${avg > 150 ? ' — pages will feel slow; pick a region closer to you if the provider offers one' : ''}`);
  } catch (e) {
    bad('Unexpected error', e.message);
  } finally {
    c.release();
  }
  return finish();
})();

async function finish() {
  const icon = { ok: '✔', warn: '!', fail: '✘' };
  for (const r of results) console.log(`  ${icon[r.s]} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  const fails = results.filter((r) => r.s === 'fail').length;
  const warns = results.filter((r) => r.s === 'warn').length;
  console.log(`\n${fails ? `✘ ${fails} problem(s) to fix` : warns ? `Ready, with ${warns} warning(s)` : 'Ready'}\n`);
  await closePool().catch(() => {});
  process.exitCode = fails ? 1 : 0;
}
