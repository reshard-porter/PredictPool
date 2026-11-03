-- PredictPool MVP — initial schema
-- All monetary values are integer minor units (BIGINT). No floats anywhere in money paths.
-- Financial history (ledger, postings, audit, payment events, status history) is append-only,
-- enforced by triggers below.

-- gen_random_uuid() is built into PostgreSQL 13+. Only older servers need pgcrypto, and shared
-- hosts often refuse CREATE EXTENSION, so it is attempted only where it is actually required.
DO $$ BEGIN
  IF current_setting('server_version_num')::int < 130000 THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

-- ─────────────────────────────────────────────── identity & access
CREATE TABLE users (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                     text NOT NULL,
  password_hash             text NOT NULL,
  display_name              text NOT NULL,
  status                    text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  verification_status       text NOT NULL DEFAULT 'UNVERIFIED'
                              CHECK (verification_status IN ('UNVERIFIED','VERIFIED','REJECTED')),
  jurisdiction              text,
  self_excluded_until       timestamptz,
  daily_deposit_limit_minor bigint CHECK (daily_deposit_limit_minor IS NULL OR daily_deposit_limit_minor >= 0),
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

-- Protected identity data: encrypted at the application layer (AES-256-GCM).
-- Only a masked suffix is stored in clear for display/support.
CREATE TABLE identity_records (
  user_id             uuid PRIMARY KEY REFERENCES users(id),
  full_name_enc       text NOT NULL,
  date_of_birth_enc   text NOT NULL,
  document_number_enc text NOT NULL,
  document_last4      text NOT NULL,
  key_version         int  NOT NULL DEFAULT 1,
  provider            text NOT NULL,
  provider_ref        text NOT NULL,
  decision            text NOT NULL CHECK (decision IN ('VERIFIED','REJECTED')),
  decision_reasons    jsonb NOT NULL DEFAULT '[]',
  checked_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,
  display_name    text NOT NULL,
  password_hash   text NOT NULL,
  totp_secret_enc text NOT NULL,
  roles           text[] NOT NULL CHECK (roles <@ ARRAY['OPS','RESULTS','FINANCE','AUDITOR']::text[]),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('USER','ADMIN')),
  subject_id   uuid NOT NULL,
  mfa_verified boolean NOT NULL DEFAULT false,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────── catalogue
CREATE TABLE sponsors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('SPONSOR','OPERATOR')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('MATCH','TOURNAMENT')),
  sport            text NOT NULL,
  starts_at        timestamptz NOT NULL,
  original_starts_at timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'SCHEDULED'
                     CHECK (status IN ('SCHEDULED','POSTPONED','FINISHED','CANCELLED')),
  official_source  text NOT NULL,          -- documented official result source
  source_event_ref text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE selections (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  code     text NOT NULL,
  label    text NOT NULL,
  UNIQUE (event_id, code),
  UNIQUE (id, event_id)
);

-- ─────────────────────────────────────────────── pools
CREATE TABLE pools (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES events(id),
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                       ('DRAFT','OPEN','LOCKED','RESULT_REVIEW','DISPUTED','RESULT_CONFIRMED',
                        'CANCELLED','SETTLING','SETTLED','REFUNDED')),
  model              text NOT NULL DEFAULT 'REFUNDABLE' CHECK (model IN ('REFUNDABLE')),
  currency           char(3) NOT NULL,
  entry_amount_minor bigint NOT NULL CHECK (entry_amount_minor > 0),
  fee_bps            int    NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  fee_basis          text   NOT NULL DEFAULT 'PERCENT_OF_DEPOSIT_ROUND_HALF_UP',
  fee_minor          bigint NOT NULL CHECK (fee_minor >= 0),
  refundable_minor   bigint NOT NULL CHECK (refundable_minor >= 0),
  prize_budget_minor bigint NOT NULL CHECK (prize_budget_minor > 0),
  prize_source       text   NOT NULL CHECK (prize_source IN ('SPONSOR','OPERATOR')),
  sponsor_id         uuid   NOT NULL REFERENCES sponsors(id),
  withholding_rule   text   NOT NULL DEFAULT 'NONE_CONFIGURED',
  withholding_bps    int    NOT NULL DEFAULT 0 CHECK (withholding_bps BETWEEN 0 AND 10000),
  entry_deadline     timestamptz NOT NULL,
  max_entries        int    NOT NULL CHECK (max_entries > 0),
  postponement_window_hours int NOT NULL DEFAULT 72,
  rules_version      text   NOT NULL,
  terms              jsonb  NOT NULL,
  terms_hash         text   NOT NULL,
  winning_selection_id uuid REFERENCES selections(id),
  settlement_outcome text CHECK (settlement_outcome IN ('PAYOUT','FULL_REFUND')),
  settlement_reason  text,
  created_by         uuid NOT NULL REFERENCES admins(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  opened_at          timestamptz,
  settled_at         timestamptz,
  CHECK (fee_minor + refundable_minor = entry_amount_minor)
);

-- Financial terms are frozen as soon as a pool leaves DRAFT (i.e. before any entry can exist).
CREATE FUNCTION pools_freeze_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
       NEW.currency IS DISTINCT FROM OLD.currency OR
       NEW.entry_amount_minor IS DISTINCT FROM OLD.entry_amount_minor OR
       NEW.fee_bps IS DISTINCT FROM OLD.fee_bps OR
       NEW.fee_basis IS DISTINCT FROM OLD.fee_basis OR
       NEW.fee_minor IS DISTINCT FROM OLD.fee_minor OR
       NEW.refundable_minor IS DISTINCT FROM OLD.refundable_minor OR
       NEW.prize_budget_minor IS DISTINCT FROM OLD.prize_budget_minor OR
       NEW.prize_source IS DISTINCT FROM OLD.prize_source OR
       NEW.sponsor_id IS DISTINCT FROM OLD.sponsor_id OR
       NEW.withholding_rule IS DISTINCT FROM OLD.withholding_rule OR
       NEW.withholding_bps IS DISTINCT FROM OLD.withholding_bps OR
       NEW.entry_deadline IS DISTINCT FROM OLD.entry_deadline OR
       NEW.max_entries IS DISTINCT FROM OLD.max_entries OR
       NEW.event_id IS DISTINCT FROM OLD.event_id OR
       NEW.rules_version IS DISTINCT FROM OLD.rules_version OR
       NEW.terms IS DISTINCT FROM OLD.terms OR
       NEW.terms_hash IS DISTINCT FROM OLD.terms_hash) THEN
    RAISE EXCEPTION 'POOL_TERMS_FROZEN: financial terms of pool % cannot change after opening', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pools_freeze_terms BEFORE UPDATE ON pools FOR EACH ROW EXECUTE FUNCTION pools_freeze_terms();

CREATE TABLE pool_status_history (
  id          bigserial PRIMARY KEY,
  pool_id     uuid NOT NULL REFERENCES pools(id),
  from_status text,
  to_status   text NOT NULL,
  actor_type  text NOT NULL,
  actor_id    text,
  reason      text,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id          uuid NOT NULL REFERENCES pools(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  event_id         uuid NOT NULL,
  selection_id     uuid NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  fee_minor        bigint NOT NULL,
  refundable_minor bigint NOT NULL,
  rules_version    text NOT NULL,
  terms_hash       text NOT NULL,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SETTLED','REFUNDED')),
  accepted_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  lock_txn_id      uuid NOT NULL,
  FOREIGN KEY (selection_id, event_id) REFERENCES selections(id, event_id),
  UNIQUE (pool_id, user_id)                -- one entry per verified account per pool
);
CREATE INDEX entries_user_idx ON entries (user_id);

-- ─────────────────────────────────────────────── results & disputes
CREATE TABLE results (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id             uuid NOT NULL REFERENCES events(id),
  version              int  NOT NULL,
  outcome_type         text NOT NULL CHECK (outcome_type IN ('WINNER','TIE','NO_RESULT')),
  winning_selection_id uuid REFERENCES selections(id),
  source               text NOT NULL,
  source_ref           text NOT NULL,
  is_final             boolean NOT NULL,
  raw                  jsonb NOT NULL,
  recorded_by          uuid REFERENCES admins(id),
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, version),
  CHECK ((outcome_type = 'WINNER') = (winning_selection_id IS NOT NULL))
);

CREATE TABLE disputes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id         uuid NOT NULL REFERENCES pools(id),
  raised_by_type  text NOT NULL CHECK (raised_by_type IN ('USER','ADMIN')),
  raised_by_id    uuid NOT NULL,
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UPHELD','REJECTED')),
  resolution_note text,
  resolved_by     uuid REFERENCES admins(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

-- ─────────────────────────────────────────────── ledger (append-only double entry)
CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type           text NOT NULL CHECK (type IN (
                   'USER_AVAILABLE',          -- liability: withdrawable customer funds
                   'USER_LOCKED',             -- liability: customer deposit locked in one pool
                   'USER_PENDING_WITHDRAWAL', -- liability: customer funds in payout flight
                   'SPONSOR_AVAILABLE',       -- liability: sponsor funds not yet allocated
                   'POOL_PRIZE_ESCROW',       -- liability: confirmed prize funding for one pool
                   'FEE_REVENUE',             -- equity/revenue: platform fees earned
                   'WITHHOLDING_PAYABLE',     -- liability: amounts withheld under a configured rule
                   'PROVIDER_CLEARING'        -- asset mirror: money held at payment provider
                 )),
  currency       char(3) NOT NULL,
  user_id        uuid REFERENCES users(id),
  pool_id        uuid REFERENCES pools(id),
  sponsor_id     uuid REFERENCES sponsors(id),
  allow_negative boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_identity_uq ON accounts (type, currency,
  coalesce(user_id, '00000000-0000-0000-0000-000000000000'),
  coalesce(pool_id, '00000000-0000-0000-0000-000000000000'),
  coalesce(sponsor_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE ledger_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  type            text NOT NULL,
  description     text NOT NULL,
  payload_hash    text NOT NULL,
  user_id         uuid,
  pool_id         uuid,
  entry_id        uuid,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE postings (
  id             bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id     uuid NOT NULL REFERENCES accounts(id),
  currency       char(3) NOT NULL,
  amount_minor   bigint NOT NULL CHECK (amount_minor <> 0)
);
CREATE INDEX postings_account_idx ON postings (account_id);
CREATE INDEX postings_txn_idx ON postings (transaction_id);

-- Posting currency must match its account.
CREATE FUNCTION postings_currency_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT currency FROM accounts WHERE id = NEW.account_id) <> NEW.currency THEN
    RAISE EXCEPTION 'LEDGER_CURRENCY_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER postings_currency_check BEFORE INSERT ON postings
  FOR EACH ROW EXECUTE FUNCTION postings_currency_check();

-- Every transaction must balance to zero within each currency (checked at COMMIT).
CREATE FUNCTION ledger_txn_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad record; n int;
BEGIN
  SELECT count(*) INTO n FROM postings WHERE transaction_id = NEW.transaction_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: transaction % has fewer than two postings', NEW.transaction_id;
  END IF;
  SELECT currency, sum(amount_minor) AS s INTO bad FROM postings
   WHERE transaction_id = NEW.transaction_id GROUP BY currency HAVING sum(amount_minor) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: transaction % currency % off by %', NEW.transaction_id, bad.currency, bad.s;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_txn_balanced AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_txn_balanced();

-- Non-negative balances for accounts that disallow overdraft (checked at COMMIT).
CREATE FUNCTION ledger_no_overdraft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bal bigint; neg boolean;
BEGIN
  SELECT allow_negative INTO neg FROM accounts WHERE id = NEW.account_id;
  IF NOT neg THEN
    SELECT coalesce(sum(amount_minor),0) INTO bal FROM postings WHERE account_id = NEW.account_id;
    IF bal < 0 THEN
      RAISE EXCEPTION 'LEDGER_OVERDRAFT: account % would be %', NEW.account_id, bal;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_no_overdraft AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_no_overdraft();

CREATE VIEW account_balances AS
  SELECT a.*, coalesce(sum(p.amount_minor), 0)::bigint AS balance_minor
    FROM accounts a LEFT JOIN postings p ON p.account_id = a.id
   GROUP BY a.id;

-- ─────────────────────────────────────────────── payments
CREATE TABLE payment_intents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            char(3) NOT NULL,
  provider            text NOT NULL,
  provider_payment_id text UNIQUE,
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  ledger_txn_id       uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_events (   -- raw, verified provider callbacks; unique per provider event id (replay guard)
  id                bigserial PRIMARY KEY,
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  type              text NOT NULL,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE withdrawals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  currency           char(3) NOT NULL,
  status             text NOT NULL DEFAULT 'REQUESTED'
                       CHECK (status IN ('REQUESTED','PROCESSING','PAID','FAILED')),
  provider           text NOT NULL,
  provider_payout_id text UNIQUE,
  failure_reason     text,
  attempts           int NOT NULL DEFAULT 0,
  hold_txn_id        uuid NOT NULL,
  final_txn_id       uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  subject_id      uuid NOT NULL,
  key             text NOT NULL,
  endpoint        text NOT NULL,
  request_hash    text NOT NULL,
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, key)
);

-- ─────────────────────────────────────────────── settlement
CREATE TABLE settlement_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id      uuid NOT NULL UNIQUE REFERENCES pools(id),   -- at most one run per pool
  outcome      text NOT NULL CHECK (outcome IN ('PAYOUT','FULL_REFUND')),
  reason       text NOT NULL,
  result_id    uuid REFERENCES results(id),
  plan_hash    text NOT NULL,
  totals       jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  attempts     int NOT NULL DEFAULT 1,
  started_by   text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE settlement_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES settlement_runs(id),
  pool_id           uuid NOT NULL REFERENCES pools(id),
  entry_id          uuid NOT NULL UNIQUE REFERENCES entries(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  is_correct        boolean NOT NULL,
  deposit_minor     bigint NOT NULL,
  fee_minor         bigint NOT NULL,
  refund_minor      bigint NOT NULL,
  bonus_gross_minor bigint NOT NULL,
  withholding_minor bigint NOT NULL,
  net_credit_minor  bigint NOT NULL,
  ledger_txn_id     uuid,
  CHECK (fee_minor + refund_minor = deposit_minor),
  CHECK (net_credit_minor = refund_minor + bonus_gross_minor - withholding_minor)
);

-- ─────────────────────────────────────────────── outbox & audit
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  dedupe_key   text UNIQUE,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','DEAD')),
  attempts     int NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (available_at) WHERE status = 'PENDING';

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_type  text NOT NULL,
  actor_id    text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  details     jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash   text NOT NULL,
  hash        text NOT NULL
);

-- ─────────────────────────────────────────────── immutability guards
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE: % on % is not allowed', TG_OP, TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_transactions','postings','audit_log','payment_events','pool_status_history','results']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()', t, t);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()', t, t);
  END LOOP;
END $$;

-- Settlement lines may only gain their ledger_txn_id once.
CREATE FUNCTION settlement_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'IMMUTABLE: settlement_lines'; END IF;
  IF OLD.ledger_txn_id IS NOT NULL
     OR (to_jsonb(NEW) - 'ledger_txn_id') <> (to_jsonb(OLD) - 'ledger_txn_id') THEN
    RAISE EXCEPTION 'IMMUTABLE: settlement_lines may only record ledger_txn_id once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_lines_guard BEFORE UPDATE OR DELETE ON settlement_lines
  FOR EACH ROW EXECUTE FUNCTION settlement_lines_guard();

-- ─────────────────────────────────────────────── simulated payment provider (provider's own books)
-- Models an external system for reconciliation. Kept in the app schema with a prefix (not a
-- separate schema) so the app runs on shared hosts that don't allow CREATE SCHEMA.
CREATE TABLE mock_provider_transactions (
  id           text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('PAYIN','PAYOUT')),
  merchant_ref text NOT NULL UNIQUE,
  amount_minor bigint NOT NULL,
  currency     char(3) NOT NULL,
  status       text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mock_provider_settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
