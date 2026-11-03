'use strict';
/**
 * Reset the database and load fictional demo data.
 * Usage: node scripts/seed.js          (local database)
 *        node scripts/seed.js --yes    (remote database, e.g. filess.io — erases this app's tables there)
 */
const { config } = require('../src/config');
const { migrate, getPool, closePool, describeTarget } = require('../src/db');
if (process.argv.includes('--yes')) config.db.allowReset = true;
const C = require('../src/crypto');
const pools = require('../src/services/pools');
const users = require('../src/services/users');
const wallet = require('../src/services/wallet');
const entries = require('../src/services/entries');

async function seedAdmins() {
  const admins = [
    { email: 'ops@demo.test', name: 'Olivia Ops (demo)', roles: ['OPS', 'RESULTS', 'FINANCE', 'AUDITOR'] },
    { email: 'auditor@demo.test', name: 'Ari Auditor (demo)', roles: ['AUDITOR'] },
  ];
  const out = {};
  for (const a of admins) {
    const { rows: [r] } = await getPool().query(`INSERT INTO admins(email, display_name, password_hash, totp_secret_enc, roles)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`, [a.email, a.name, C.hashPassword('demo-password'), C.encryptPII(C.newTotpSecret()), a.roles]);
    out[a.email] = r;
  }
  return out;
}

async function fundedUser(email, name, amountMinor) {
  const u = await users.register({ email, password: 'demo-password', displayName: name });
  await users.submitVerification(u.id, { fullName: name, dateOfBirth: '1990-04-12', documentNumber: `D${Math.floor(Math.random() * 1e8)}`, jurisdiction: 'DEMO' });
  const d = await wallet.createDeposit(u.id, amountMinor);
  await wallet.simulateCheckout(u.id, d.depositId);
  return u;
}

async function seed() {
  console.log(`Seeding ${describeTarget().label}`);
  await migrate({ reset: true });
  const admins = await seedAdmins();
  const admin = admins['ops@demo.test'];
  const sponsor = await pools.createSponsor(admin, { name: 'Brightline Sports Drinks (fictional sponsor)', kind: 'SPONSOR' });

  const h = (hrs) => new Date(Date.now() + hrs * 3.6e6).toISOString();
  const match = await pools.createEvent(admin, { name: 'Harbor City FC vs Northgate United', kind: 'MATCH', sport: 'Football',
    startsAt: h(48), sourceEventRef: 'mock-match-001', selections: [{ code: 'HOME', label: 'Harbor City FC' }, { code: 'AWAY', label: 'Northgate United' }] });
  const tourney = await pools.createEvent(admin, { name: 'Coastal Cup 2026 — Tournament Winner', kind: 'TOURNAMENT', sport: 'Basketball',
    startsAt: h(96), sourceEventRef: 'mock-cup-2026', selections: [
      { code: 'ORCAS', label: 'Bayside Orcas' }, { code: 'RIDGE', label: 'Ridgeback Runners' },
      { code: 'COMETS', label: 'Lakeshore Comets' }, { code: 'PINES', label: 'Pinecrest Pines' }] });

  const p1 = await pools.createPool(admin, { eventId: match.id, name: 'Harbor vs Northgate — Match Winner Pool', entryAmountMinor: 1000, feeBps: 500,
    prizeBudgetMinor: 10000, sponsorId: sponsor.id, entryDeadline: h(47) });
  const p2 = await pools.createPool(admin, { eventId: tourney.id, name: 'Coastal Cup Champion Pool', entryAmountMinor: 2500, feeBps: 400,
    prizeBudgetMinor: 50000, sponsorId: sponsor.id, entryDeadline: h(95) });
  const p3 = await pools.createPool(admin, { eventId: match.id, name: 'Draft pool (unfunded — cannot open)', entryAmountMinor: 1000, feeBps: 500,
    prizeBudgetMinor: 20000, sponsorId: sponsor.id, entryDeadline: h(47) });
  for (const p of [p1, p2]) { await pools.fundPrize(admin, p.id); await pools.openPool(admin, p.id); }

  // Background participants so pick counts and estimates are meaningful.
  const { rows: sels1 } = await getPool().query('SELECT * FROM selections WHERE event_id=$1 ORDER BY code', [match.id]);
  const { rows: sels2 } = await getPool().query('SELECT * FROM selections WHERE event_id=$1 ORDER BY code', [tourney.id]);
  const names = ['Sam Rivera', 'Jo Chen', 'Priya Nair', 'Lee Okafor', 'Mia Novak', 'Tom Brandt'];
  for (let i = 0; i < names.length; i++) {
    const u = await fundedUser(`player${i + 1}@demo.test`, names[i], 10000);
    const sp1 = await pools.getPublicPool(p1.id);
    await entries.enter(u.id, p1.id, { selectionId: sels1[i % 3 === 0 ? 1 : 0].id, acceptedRulesVersion: sp1.rulesVersion, acceptedTermsHash: sp1.termsHash });
    const sp2 = await pools.getPublicPool(p2.id);
    await entries.enter(u.id, p2.id, { selectionId: sels2[i % 4].id, acceptedRulesVersion: sp2.rulesVersion, acceptedTermsHash: sp2.termsHash });
  }
  console.log('Seeded. Pools:', p1.id, p2.id, '(draft)', p3.id);
  console.log('Ops login: ops@demo.test / demo-password + demo authenticator code');
}

if (require.main === module) seed().then(closePool).catch((e) => { console.error(e.message || e); process.exit(1); });
module.exports = { seed, seedAdmins, fundedUser };
