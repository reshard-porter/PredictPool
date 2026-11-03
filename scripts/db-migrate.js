'use strict';
/** Apply pending migrations without touching existing data. Usage: npm run db:migrate */
const { migrate, closePool, describeTarget } = require('../src/db');

(async () => {
  console.log(`Migrating ${describeTarget().label}`);
  const applied = await migrate();
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(closePool);
