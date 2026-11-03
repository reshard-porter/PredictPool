# 5 · Entity-relationship diagram and migrations

The migration is in [`db/migrations/001_init.sql`](../db/migrations/001_init.sql). `src/db.js#migrate()` applies it and records it in `schema_migrations`.

```mermaid
erDiagram
  users ||--o| identity_records : "verified by"
  users ||--o{ entries : places
  users ||--o{ payment_intents : funds
  users ||--o{ withdrawals : requests
  users ||--o{ accounts : owns
  admins ||--o{ pools : creates
  admins ||--o{ results : records
  sponsors ||--o{ pools : "funds prize of"
  sponsors ||--o{ accounts : owns
  events ||--|{ selections : offers
  events ||--o{ pools : hosts
  events ||--o{ results : "has versions"
  pools ||--o{ entries : accepts
  pools ||--o{ pool_status_history : logs
  pools ||--o{ disputes : "may have"
  pools ||--o| settlement_runs : "settled by"
  pools ||--o{ accounts : "escrow / locked"
  selections ||--o{ entries : "picked in"
  settlement_runs ||--|{ settlement_lines : contains
  entries ||--o| settlement_lines : "settled as"
  ledger_transactions ||--|{ postings : "balanced set of"
  accounts ||--o{ postings : "moved by"

  users { uuid id PK
    text email UK
    text verification_status
    text jurisdiction
    timestamptz self_excluded_until
    bigint daily_deposit_limit_minor }
  identity_records { uuid user_id PK,FK
    text full_name_enc "AES-GCM"
    text date_of_birth_enc "AES-GCM"
    text document_number_enc "AES-GCM"
    text document_last4
    text decision }
  admins { uuid id PK
    text email UK
    text totp_secret_enc
    text_arr roles }
  sponsors { uuid id PK
    text name
    text kind "SPONSOR|OPERATOR" }
  events { uuid id PK
    text kind "MATCH|TOURNAMENT"
    timestamptz starts_at
    timestamptz original_starts_at
    text official_source
    text source_event_ref }
  selections { uuid id PK
    uuid event_id FK
    text code }
  pools { uuid id PK
    uuid event_id FK
    text status
    char currency
    bigint entry_amount_minor
    int fee_bps
    bigint fee_minor
    bigint refundable_minor
    bigint prize_budget_minor
    uuid sponsor_id FK
    int withholding_bps
    timestamptz entry_deadline
    text rules_version
    jsonb terms
    text terms_hash
    uuid winning_selection_id FK }
  entries { uuid id PK
    uuid pool_id FK
    uuid user_id FK
    uuid selection_id FK
    bigint amount_minor
    text rules_version
    text terms_hash
    timestamptz accepted_at
    uuid lock_txn_id }
  results { uuid id PK
    uuid event_id FK
    int version
    text outcome_type
    uuid winning_selection_id FK
    text source
    bool is_final }
  disputes { uuid id PK
    uuid pool_id FK
    text status }
  accounts { uuid id PK
    text type
    char currency
    uuid user_id FK
    uuid pool_id FK
    uuid sponsor_id FK
    bool allow_negative }
  ledger_transactions { uuid id PK
    text idempotency_key UK
    text type
    text payload_hash }
  postings { bigint id PK
    uuid transaction_id FK
    uuid account_id FK
    char currency
    bigint amount_minor }
  payment_intents { uuid id PK
    uuid user_id FK
    bigint amount_minor
    text provider_payment_id UK
    text status }
  payment_events { bigint id PK
    text provider
    text provider_event_id "UK with provider" }
  withdrawals { uuid id PK
    uuid user_id FK
    bigint amount_minor
    text status
    uuid hold_txn_id }
  settlement_runs { uuid id PK
    uuid pool_id "FK, UK"
    text outcome
    text plan_hash
    jsonb totals }
  settlement_lines { uuid id PK
    uuid entry_id "FK, UK"
    bigint fee_minor
    bigint refund_minor
    bigint bonus_gross_minor
    bigint withholding_minor
    bigint net_credit_minor
    uuid ledger_txn_id }
  pool_status_history { bigint id PK
    uuid pool_id FK }
```

Supporting tables not drawn above: `sessions`, `idempotency_keys`, `outbox`, `audit_log` (hash-chained), and `mock_provider_transactions` / `mock_provider_settings` (the simulated provider's own books).

## Constraints that carry business rules
| Rule | Enforcement |
|---|---|
| One entry per account per pool | `UNIQUE (entries.pool_id, entries.user_id)` |
| Entry selection belongs to the pool's event | composite FK `(selection_id, event_id) → selections(id, event_id)` |
| Fee + refundable = deposit | `CHECK` on `pools` and `settlement_lines` |
| Net = refund + bonus − withholding | `CHECK` on `settlement_lines` |
| Terms frozen after DRAFT | `pools_freeze_terms` trigger |
| Balanced transactions | deferred constraint trigger `ledger_txn_balanced` |
| No overdraft (except clearing) | deferred constraint trigger `ledger_no_overdraft` |
| Immutable history | `forbid_mutation` triggers on ledger, postings, audit, payment events, results, status history (update, delete, truncate) |
| Settlement line written once | `settlement_lines_guard` |
| One settlement per pool | `UNIQUE settlement_runs.pool_id` |
| Callback replay | `UNIQUE (payment_events.provider, provider_event_id)` |
| Results only as a winner when a winner exists | `CHECK ((outcome_type='WINNER') = (winning_selection_id IS NOT NULL))` |
