'use strict';
const { migrate, describeTarget } = require('./db');
const { config } = require('./config');
const { buildApp } = require('./http/app');
const worker = require('./worker');

(async () => {
  console.log(`Database: ${describeTarget().label}`);
  await migrate();
  buildApp().listen(config.port, () => console.log(`PredictPool MVP (SIMULATED FUNDS) on http://localhost:${config.port}  ·  ops portal: /ops.html`));
  worker.start({ intervalMs: config.workerPollMs });
})().catch((e) => { console.error(`Could not start: ${e.message}. Run "npm run db:check" to diagnose the database connection.`); process.exit(1); });
