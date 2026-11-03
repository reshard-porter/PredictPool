# 6 · API contracts

Base path: `/api`. JSON in and out. All money fields are **integer minor units** with the suffix `…Minor`. Authentication uses `Authorization: Bearer <token>`.

The examples below are real responses captured from the running demo. Ids have been shortened where marked `…`.

## Conventions
| Topic | Contract |
|---|---|
| Errors | `{"error": {"code": "SNAKE_CASE", "message": "…", "details": {…}}}` with the matching HTTP status: 400 validation, 401 auth, 402 insufficient funds, 403 eligibility/role, 404, 409 state conflict, 422 idempotency-key misuse |
| Idempotency | **Required** `Idempotency-Key` header on `POST /wallet/deposits`, `POST /pools/:id/entries`, `POST /wallet/withdrawals`. Same key + same body replays the stored response with `Idempotent-Replay: true`. Same key + different body returns `422 IDEMPOTENCY_KEY_REUSED`. A request still in flight returns `409 REQUEST_IN_PROGRESS`. |
| Time | ISO-8601 UTC. Deadlines are evaluated against the database clock. `serverTime` is returned so clients can correct for clock skew. |
| Funds | Every money response carries `simulated: true` or `fundsMode: "SIMULATED"`. |

## Endpoint index
| Method & path | Auth | Purpose |
|---|---|---|
| `GET /config` | – | Currency, funds mode, jurisdiction status |
| `POST /auth/register` · `POST /auth/login` | – | Participant account and session |
| `POST /admin/auth/login` | – | Admin login; **requires** `totpCode` |
| `GET /pools` · `GET /pools/:id` | optional | Catalogue and full disclosure |
| `GET /me` | user | Profile (masked PII) and balances |
| `POST /me/verification` | user | Identity and eligibility check |
| `PUT /me/limits` · `POST /me/self-exclusion` | user | Responsible-play controls |
| `POST /wallet/deposits` | user + key | Create a pending deposit and checkout |
| `POST /wallet/deposits/:id/simulate-checkout` | user (demo) | Pay at the mock checkout; the provider sends a signed webhook |
| `POST /webhooks/payments/mockpay` | signature | Provider callback (`MockPay-Signature: t=…,v1=…`) |
| `POST /pools/:id/entries` | user + key | Confirm an entry and get a receipt |
| `GET /me/entries` · `GET /entries/:id/receipt` · `GET /entries/:id/settlement` | user | Tracking, receipt, itemised statement |
| `POST /pools/:id/disputes` | user (entrant) | Dispute a result before settlement |
| `POST /wallet/withdrawals` · `GET /wallet/withdrawals` · `GET /wallet/transactions` | user | Withdraw and history |
| `GET /admin/overview` | any admin | Pools, escrow, locked, events, disputes, withdrawals |
| `POST /admin/sponsors` · `POST /admin/events` · `POST /admin/pools` | OPS | Catalogue management |
| `POST /admin/pools/:id/fund-prize` | FINANCE | Simulated sponsor pay-in and escrow |
| `GET /admin/pools/:id/funding` | any admin | Funding check |
| `POST /admin/pools/:id/open` · `/cancel` · `POST /admin/events/:id/postpone` | OPS | Lifecycle |
| `POST /admin/events/:id/feed-result` (demo) · `/ingest-result` | RESULTS | Official result |
| `POST /admin/pools/:id/confirm-result` · `/disputes` · `POST /admin/disputes/:id/resolve` | RESULTS | Review |
| `GET /admin/pools/:id/settlement-preview` | any admin | Deterministic preview, or the persisted run |
| `POST /admin/pools/:id/settle` | FINANCE | Queue settlement (dedupe-keyed) |
| `GET /admin/reconciliation` | FINANCE/AUDITOR | Invariants and provider match |
| `GET /admin/audit` | AUDITOR/OPS | Hash-chained audit log |
| `GET /admin/users/:id/identity?reason=…` | OPS | Masked identity; reveal requires a reason and is audited |
| `POST /admin/mock/payout-mode` | FINANCE (demo) | Inject provider failures |

---

### Fund the account
```http
POST /api/wallet/deposits
Authorization: Bearer <user>
Idempotency-Key: dep-001

{"amountMinor": 2000}
```
```json
201
{"depositId":"9dbe232e-…","status":"PENDING","amountMinor":2000,"currency":"USD",
 "providerPaymentId":"pay_07befbfdff173607","checkoutUrl":"/demo/checkout?merchantRef=9dbe232e-…","simulated":true}
```

Provider callback (sent by MockPay after checkout):
```http
POST /webhooks/payments/mockpay
MockPay-Signature: t=1793640118,v1=5f1c…(hex HMAC-SHA256 of "t.body")

{"id":"evt_…","type":"payment.succeeded","created":1793640118,
 "data":{"providerPaymentId":"pay_07befbfdff173607","merchantRef":"9dbe232e-…","amountMinor":2000,"currency":"USD"}}
```
```json
200 {"status":"credited","txnId":"8d9ff84e-…"}
200 {"status":"duplicate_ignored","eventId":"evt_…"}         // same event again
200 {"status":"already_credited"}                            // new event id, same payment
401 {"error":{"code":"BAD_SIGNATURE"}} | {"error":{"code":"TIMESTAMP_OUTSIDE_TOLERANCE"}}
```

### Pool disclosure
```http
GET /api/pools/55b859bc-…
```
```json
{"id":"55b859bc-…","name":"Harbor vs Northgate — Match Winner Pool","status":"OPEN","model":"REFUNDABLE","fundsMode":"SIMULATED",
 "event":{"name":"Harbor City FC vs Northgate United","kind":"MATCH","startsAt":"2026-11-04T17:21:57.511Z",
          "officialSource":"MockSportsFeed v1 (simulated official source)"},
 "currency":"USD","entryDeadline":"2026-11-04T16:21:57.519Z","serverTime":"2026-11-02T17:21:58.330Z",
 "disclosure":{"depositMinor":1000,"feeMinor":50,"feeBps":500,"feeBasis":"PERCENT_OF_DEPOSIT_ROUND_HALF_UP",
   "refundableMinor":950,"prizeBudgetMinor":10000,"prizeSource":"SPONSOR","withholdingRule":"NONE_CONFIGURED","withholdingBps":0,
   "youCanLose":"You can lose the platform fee (USD 0.50). There is no guaranteed profit."},
 "selections":[{"id":"eb3d6023-…","code":"HOME","label":"Harbor City FC","picks":2,
   "bonusEstimate":{"maximumGrossMinor":10000,"estimateGrossMinor":3333,"estimateWithholdingMinor":0,
     "basis":"Funded budget ÷ (2 existing picks + you). Changes as others enter.","isEstimate":true}}, "…"],
 "entries":6,"maxEntries":10000,"rulesVersion":"refundable-v1.0","termsHash":"ee0354f1…","settlementRules":["…"],
 "postponementWindowHours":72,"myEntry":null}
```

### Enter a pool
```http
POST /api/pools/55b859bc-…/entries
Authorization: Bearer <user>
Idempotency-Key: enter-001

{"selectionId":"eb3d6023-…","acceptedRulesVersion":"refundable-v1.0","acceptedTermsHash":"ee0354f1…"}
```
```json
201
{"receiptId":"RCPT-4C640DED","entryId":"4c640ded-…","poolId":"55b859bc-…","poolName":"Harbor vs Northgate — Match Winner Pool",
 "selection":{"id":"eb3d6023-…","code":"HOME","label":"Harbor City FC"},"currency":"USD",
 "depositMinor":1000,"feeMinor":50,"refundableMinor":950,"prizeBudgetMinor":10000,
 "acceptedAt":"2026-11-02T17:21:58.352Z","rulesVersion":"refundable-v1.0","termsHash":"ee0354f1…",
 "ledgerTransactionId":"e98968c6-…","status":"ACTIVE","fundsMode":"SIMULATED"}
```
Error cases:
- `409 ALREADY_ENTERED`, with `details.entryId`
- `409 ENTRY_DEADLINE_PASSED`, with the server time in the message
- `409 POOL_NOT_OPEN`
- `409 TERMS_CHANGED`, with the current version and hash in `details`
- `402 INSUFFICIENT_FUNDS`
- `403 NOT_VERIFIED`, `SELF_EXCLUDED`, or `JURISDICTION_NOT_ELIGIBLE`
- `409 POOL_FULL`
- `422 IDEMPOTENCY_KEY_REUSED`

### Balances
```json
GET /api/me → 200
{"profile":{"email":"ana@example.test","verificationStatus":"VERIFIED","jurisdiction":"DEMO","dailyDepositLimitMinor":50000,"documentMasked":"••••4321"},
 "balances":{"currency":"USD","availableMinor":1000,"lockedMinor":1000,"pendingWithdrawalMinor":0}}
```

### Operations: result → confirm → preview → settle
```http
POST /api/admin/auth/login        {"email":"ops@demo.test","password":"…","totpCode":"492817"}
→ 200 {"token":"…","adminId":"4538cd2d-…","roles":["OPS","RESULTS","FINANCE","AUDITOR"]}

POST /api/admin/events/eb94ecc9-…/ingest-result
→ 200 {"resultId":"9ff5abfd-…","version":1,"affectedPools":["55b859bc-…"]}

POST /api/admin/pools/55b859bc-…/confirm-result
→ 200 {"status":"RESULT_CONFIRMED","resultVersion":1,"outcomeType":"WINNER"}
→ 409 DISPUTE_OPEN | RESULT_NOT_FINAL | DISPUTE_WINDOW_OPEN | INVALID_STATE

GET /api/admin/pools/55b859bc-…/settlement-preview
→ 200 {"persisted":false,"mode":"PAYOUT","reason":"Official result confirmed; correct predictions share the prize budget.",
       "bonusEachMinor":3333,
       "lines":[{"entryId":"3ebe5b3e-…","isCorrect":false,"depositMinor":1000,"feeMinor":50,"refundMinor":950,
                 "bonusGrossMinor":0,"withholdingMinor":0,"netCreditMinor":950}, "…"],
       "totals":{"entries":7,"correct":3,"depositsMinor":7000,"feesMinor":350,"refundsMinor":6650,"bonusGrossMinor":9999,
                 "withholdingMinor":0,"netCreditsMinor":16649,"prizeBudgetMinor":10000,"prizeReturnedToFunderMinor":1}}

POST /api/admin/pools/55b859bc-…/settle
→ 202 {"queued":true}
```

### Itemised settlement
```json
GET /api/entries/4c640ded-…/settlement → 200
{"poolName":"Harbor vs Northgate — Match Winner Pool","selection":"Harbor City FC","currency":"USD","outcome":"PAYOUT",
 "isCorrect":true,"settledAt":"2026-11-02T17:21:58.511Z","ledgerTransactionId":"913ce2e6-…",
 "items":[{"label":"Deposit","amountMinor":1000},{"label":"Platform fee","amountMinor":-50},
          {"label":"Returned deposit","amountMinor":950,"subtotal":true},{"label":"Prize bonus (gross)","amountMinor":3333},
          {"label":"Withholding","amountMinor":0},{"label":"Net credit to available balance","amountMinor":4283,"total":true}]}
```

### Withdraw
```http
POST /api/wallet/withdrawals
Idempotency-Key: wd-001

{"amountMinor":5000}
```
```json
202 {"withdrawalId":"9a24eec4-…","status":"REQUESTED","amountMinor":5000,"currency":"USD","failureReason":null,"attempts":0,"simulated":true}
```
The worker then moves the withdrawal to `PAID`, or to `FAILED` with `failureReason` (for example `BENEFICIARY_ACCOUNT_DECLINED`), in which case the funds return to `availableMinor`.

### Reconciliation
```json
GET /api/admin/reconciliation → 200
{"invariants":{"ok":true,"checks":[{"name":"Every ledger transaction balances per currency","ok":true}, "…"]},
 "provider":{"ok":true,"providerNetMinor":122000,"ledgerClearingMinor":122000,"issues":[]}}
```
