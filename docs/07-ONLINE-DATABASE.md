# 7 · Running on an online database (filess.io)

The app can use any hosted PostgreSQL 13+ instead of a database on your computer. This guide uses **filess.io**. The same steps work for other providers: Neon, Supabase, Aiven, Render and so on.

Only the database moves online. The API server still runs wherever you start it with `npm start` (your computer, for now), and the web and mobile apps connect to that server.

## What filess.io's free plan means for this app
These figures come from third-party listings and user reports, not from filess.io's own documentation. Check your dashboard for the current limits.

| Limit (free "Shared" plan) | What it means here |
|---|---|
| **2 databases** | Use one for the app. Keep running the tests on your local database (see below). |
| **10 MB per database** | The app plus demo data is about **1 MB of tables**. An *empty* PostgreSQL database already takes about 7.5 MB of built-in system catalogs, so if filess counts the whole database you are near the limit (about 9 MB measured). Check usage in the dashboard after setup. Fine for a demo; not enough for real use. |
| **About 3 connections at once** | Set `DB_POOL_MAX=2` so one connection is left for a SQL editor. Don't run two copies of the server at once. |
| **Weekly backups** | Don't treat it as the only copy of anything important. |

Funds stay **simulated**. Moving the database online doesn't change that.

## Steps

### 1. Create the database
1. Sign up at filess.io and create a new database.
2. Choose **PostgreSQL** and the free plan, and pick the region closest to you. Every page load makes several database round trips, so distance matters.
3. Open the database's connection details. You need the **host, port, database name, user name and password**.

### 2. Put the details in `.env`
In the `predictpool` folder:
```bash
cp .env.example .env
```
Then edit `.env`:
```ini
DB_HOST=your-host-from-the-dashboard
DB_PORT=your-port
DB_NAME=your-database-name
DB_USER=your-user
DB_PASSWORD="your-password"
DB_SCHEMA=predictpool
DB_SSL=off
DB_POOL_MAX=2
WORKER_POLL_MS=2000
```
- **Set `DB_SCHEMA`.** On filess.io your user has no default schema, so without it migration fails with "no schema has been selected to create in". The app creates the schema if it's missing.
- **SSL:** filess.io's free shared plan rejects SSL on its standard port ("The server does not support SSL connections"), so use `DB_SSL=off`. The connection is then unencrypted: use a password you don't use anywhere else, and keep real personal data out of this database. If your dashboard offers an SSL port, use that port with `DB_SSL=require` instead.
- **Quote the password.** In `.env` files an unquoted `#` starts a comment, so a password containing `#` is silently cut short.
- **Using a connection string instead?** If the dashboard gives one, you can set `DATABASE_URL=postgres://user:password@host:port/dbname` and leave `DB_HOST` empty. Special characters in the password must then be URL-encoded (`@` becomes `%40`, `#` becomes `%23`). The separate fields avoid that problem.
- **Keep it private.** `.env` is in `.gitignore`; never commit it or paste it anywhere. If the password has ever been shared, rotate it in the dashboard.

### 3. Check the connection
```bash
npm run db:check
```
This connects with your settings, changes nothing, and reports on:
- connection and encryption (SSL);
- PostgreSQL version;
- connection limits, compared with `DB_POOL_MAX`;
- every privilege the app needs: tables, triggers, deferred constraint triggers, views, row and advisory locks, UUIDs;
- storage used, schema status and query latency.

Each problem comes with a suggested fix. The common ones:

| Message | Fix |
|---|---|
| certificate could not be verified | `DB_SSL=no-verify` (still encrypted, but the certificate isn't checked), or `DB_SSL=require` with `DB_SSL_CA=path/to/provider-ca.pem` |
| server requires SSL | `DB_SSL=require` |
| server does not support SSL | `DB_SSL=off`. Only do this if the provider offers no encryption, and remember the password then travels in clear. |
| wrong user name or password | re-copy them, and quote the password |
| too many connections | close other clients (SQL editors, a second server) and lower `DB_POOL_MAX` |
| no schema has been selected to create in | add `DB_SCHEMA=predictpool` (the checker says whether your user may create it, or lists the schemas you can use) |
| cannot create tables | your user lacks the CREATE privilege on the schema; set `DB_SCHEMA` to one the checker lists, or ask the provider |

### 4. Create the tables
Choose one of these.

**With demo data** (pools, sample players, and the `ops@demo.test` admin):
```bash
npm run seed -- --yes
```
`--yes` is required because seeding *erases this app's tables* in the target database. Without it the command refuses to touch a remote database. Seed once rather than repeatedly: each full reseed adds about 0.5 MB of catalog overhead, which matters on a 10 MB plan.

**Empty, for your own pools:**
```bash
npm run db:migrate
npm run admin:create -- --email you@example.com --name "Your Name"
```
`admin:create` prints a generated password and an authenticator secret **once**. Add the secret to an authenticator app such as Google Authenticator or 1Password, then sign in to the operations portal with your email, the password and the 6-digit code.

### 5. Start the app
```bash
npm start
```
The first line printed shows which database the server is using, for example `Database: youruser@your-host:port/yourdb (ssl: require)`. Everything else is the same as before: the web app is at http://localhost:3000, the operations portal at `/ops.html`, and the mobile app is set up as in `mobile/README.md`.

## Tests stay local
`npm test` erases its database on every run, so the test suite:
- always uses `TEST_DATABASE_URL`, which defaults to your local `predictpool_test`;
- ignores `.env` completely;
- refuses to run against any host that isn't local.

The concurrency tests also open more connections than a free plan allows. To run tests you still need a local PostgreSQL.

## Going back to the local database
Rename or delete `.env`, or empty its `DB_HOST` and `DATABASE_URL` lines. The app then uses `postgres://postgres:postgres@localhost:5432/predictpool` again.

## How this was verified
I couldn't reach filess.io from where this was built, and I don't have your credentials, so it hasn't been run against your actual database. Instead it was tested against a local PostgreSQL 16 database set up like a shared host:
- an ordinary non-admin user, limited to 3 connections;
- SSL with a self-signed certificate;
- a password containing `@ : / #`;
- no `public` schema, reproducing filess.io's "no schema has been selected to create in" error (fixed with `DB_SCHEMA`);
- a non-local host name.

On that database:
- `db:check`, `db:migrate`, `seed --yes` (twice), `admin:create` with a TOTP login, and the full `npm run demo` journey all passed, with every reconciliation check green;
- the server answered 46 simultaneous requests (pool browsing, sign-ups, deposits and entries) with no errors, using 2 connections;
- the reset guard refused to erase the database without `--yes`.

`npm run db:check` is the step that confirms your real filess.io database behaves the same way.
