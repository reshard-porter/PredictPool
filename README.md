# PredictPool MVP: refundable-deposit prediction pools

PredictPool is a match and tournament prediction app where users lock a fixed deposit, pick a winner, and get it back minus a disclosed fee once the official result is final. Correct picks share the sponsor-funded prize. Built with Node.js, PostgreSQL, a double-entry ledger, an operations portal, and an iOS and Android app. All funds are simulated.

Users join a pool for a match or tournament, lock a fixed deposit, and predict the winner before the deadline. After the official result:

- **everyone gets the deposit back minus a disclosed platform fee**, and
- correct predictions share a **separately funded prize budget**.

**Funds are simulated.** Live payments are disabled in code until jurisdiction, provider approval, custody and tax rules are supplied (`src/config.js → assertLivePaymentsAllowed`).

## Quick start
Requires Node ≥ 20 and PostgreSQL ≥ 13.
```bash
npm install
createdb predictpool && createdb predictpool_test     # default URL: postgres://postgres:postgres@localhost:5432/…
npm run seed        # reset DB + fictional demo data (2 open pools, 1 unfunded draft)
npm start           # API + inline worker → http://localhost:3000   ·   ops portal → /ops.html
npm run demo        # scripted end-to-end journey over HTTP (reseeds)
npm test            # 46 tests against a real Postgres (always local; never uses .env)

npm run db:check    # diagnose the configured database (connection, SSL, limits, privileges, storage)
npm run db:migrate  # create/update tables without touching data
npm run admin:create -- --email you@example.com --name "You"   # ops admin without demo data
```
- **Participant app:** register on `/` and verify with jurisdiction `DEMO`. Then deposit, enter, and track.
- **Ops portal:** `/ops.html`. Sign in as `ops@demo.test` / `demo-password`, then press **Demo authenticator** for the TOTP code.
- **Online database (filess.io or any hosted PostgreSQL):** copy `.env.example` to `.env`, fill in the connection details, then run `npm run db:check`. See [docs/07-ONLINE-DATABASE.md](docs/07-ONLINE-DATABASE.md).
- **Mobile app:** `cd mobile && npm install && npx expo start`. See [mobile/README.md](mobile/README.md).
- **Override the database:** set `DATABASE_URL` and `TEST_DATABASE_URL`. Other settings are listed in `src/config.js`.

## Deliverables
| # | Deliverable | Where |
|---|---|---|
| 1 | PRD with assumptions and open decisions | [docs/01-PRD.md](docs/01-PRD.md) |
| 2 | Economic model, reconciled example, pari-mutuel comparison | [docs/02-ECONOMICS.md](docs/02-ECONOMICS.md) |
| 3 | User journeys and pool lifecycle state diagram | [docs/03-JOURNEYS-AND-LIFECYCLE.md](docs/03-JOURNEYS-AND-LIFECYCLE.md) |
| 4 | System architecture diagram | [docs/04-ARCHITECTURE.md](docs/04-ARCHITECTURE.md) |
| 5 | ERD and migrations | [docs/05-DATA-MODEL.md](docs/05-DATA-MODEL.md), [db/migrations/001_init.sql](db/migrations/001_init.sql) |
| 6 | API contracts with examples | [docs/06-API.md](docs/06-API.md) |
| 7 | Working demo with mock results, verification and payment adapters | `public/index.html`, `scripts/demo.js`, `src/adapters/*` |
| 8 | Operations portal | `public/ops.html` |
| 9 | Tests | `test/*.test.js` |
| 10 | **Mobile app (iOS & Android, Expo)** | [mobile/](mobile/README.md) · [screenshots](docs/screenshots/mobile-journey.png) |
| 11 | Online database setup (filess.io) | [docs/07-ONLINE-DATABASE.md](docs/07-ONLINE-DATABASE.md) |

Diagrams are Mermaid and render on GitHub. Rendered SVGs are in `docs/diagrams/`.

## Layout
```
src/
  config.js          placeholders for jurisdiction, currency, fee, limits; live-payment guard
  economics.js       pure, deterministic money math (fees, splits, rounding, pari-mutuel comparison)
  ledger.js          append-only double-entry ledger (idempotent postings, account locking)
  audit.js           hash-chained audit log
  crypto.js          scrypt, AES-256-GCM PII, RFC 6238 TOTP, webhook HMAC
  outbox.js          transactional outbox (SKIP LOCKED, leases, backoff, dead-letter)
  worker.js          outbox handlers + deadline locker
  services/          users · wallet · pools · entries · results · settlement · withdrawals · reconciliation
  adapters/          payments-mock (MockPay) · verification-mock · results-mock
  http/app.js        Express API, auth, RBAC, idempotency middleware
db/migrations/       schema, constraints, immutability and balance triggers
public/              participant web app, operations portal (responsive, no build step)
mobile/              React Native (Expo SDK 58) participant app for iOS and Android
test/                node:test suites
```

## Acceptance criteria and how they are met
| Criterion | Mechanism | Proven by |
|---|---|---|
| Every credited amount has a balanced ledger transaction | Credits happen only via `ledger.post`. A deferred trigger rejects any unbalanced commit. Each settlement line stores its `ledger_txn_id`. | `ledger.test` "rejects an unbalanced transaction"; invariant check "Every settlement credit has a ledger transaction" |
| Deposits always cover promised refunds | Per-user-per-pool `USER_LOCKED` accounts; refunds are paid only from them; reconciliation compares them with active entries × deposit | invariants run after every lifecycle test and in the demo |
| Prize allocations ≤ confirmed funding | Pool cannot open until escrow ≥ budget; floor split; invariant on the plan; escrow swept to zero at finalise | `economics.test` property test; `ledger.test` funding tests |
| Repeated requests cannot duplicate financial effects | API idempotency keys; unique ledger keys; webhook event ids; outbox dedupe; persisted settlement plan | `payments.test`, `settlement-retry.test`, `api.test`, `concurrency.test` |
| Users understand fee, refundable amount and bonus before entry | Disclosure block, "you can lose the fee" notice, bonus labelled as an estimate, confirmation dialog, rule-version acceptance | `api.test` checks the disclosure fields; screenshots |
| Demo goes from funding to simulated withdrawal | `npm run demo`, or the UI | `api.test` "full journey over HTTP" |

## Test coverage map (46 tests)
| Required scenario | Tests |
|---|---|
| Concurrent spending | one deposit vs 5 pools; 10 parallel duplicate entries; 6 parallel withdrawals; entry racing a withdrawal; capacity under concurrency |
| Duplicate callbacks | same event delivered 8× concurrently; new event id for the same payment; forged and tampered signatures; stale timestamp; amount mismatch |
| Late entries | rejected by server time while status still reads OPEN; terms-hash mismatch |
| Cancellations | full refund, no fee, prize back to sponsor; postponement beyond the window |
| No correct predictions | full refund, no fee; unsupported tie |
| Rounding | half-up fee and withholding; floor split with remainder; 2,000-case property test; order independence |
| Failed withdrawals | decline → funds returned; transient timeout → retry; lost provider response → no double payout |
| Settlement retries | crash mid-run then resume; 4 concurrent executions; outbox handler failure then retry; outbox dedupe |
| Also covered | immutability triggers, frozen terms, overdraft rejection, disputes holding settlement, result corrections, unofficial sources, MFA/RBAC, deposit limits, self-exclusion, age and eligibility checks |

## Known MVP limits
- Single currency per deployment.
- The worker runs inline with the API by default; `npm run worker` runs it standalone.
- Notifications are stubs.
- There is no four-eyes control on settlement yet. The hook points are documented.

See the open decisions in the PRD: legal classification, licensing, payment provider, custody and tax treatment must all be resolved before any real money is involved.
