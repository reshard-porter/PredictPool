# 3 · User journeys and pool lifecycle

## Participant journey
```mermaid
flowchart LR
  A[Browse pools] --> B[Pool detail:<br/>deposit, fee, refundable,<br/>prize budget, rules, estimate]
  B --> C{Signed in &<br/>verified?}
  C -- no --> C1[Register → identity &<br/>eligibility check] --> C
  C -- yes --> D{Available ≥ deposit?}
  D -- no --> D1[Deposit → simulated checkout →<br/>signed webhook → ledger credit] --> D
  D -- yes --> E[Pick winner → confirm<br/>accept rule version]
  E --> F[Receipt: selection, amount,<br/>server timestamp, rule version]
  F --> G[Track: locked deposit,<br/>pool status, official result]
  G --> H{Result issue?}
  H -- yes --> H1[Raise dispute → settlement held] --> G
  H -- no --> I[Itemised settlement:<br/>returned deposit, fee, bonus,<br/>withholding, net credit]
  I --> J[Withdraw → hold → payout<br/>PAID or FAILED→funds returned]
  J --> K[Transaction history]
```

### Journey detail
| Step | User sees | System guarantees |
|---|---|---|
| Browse | Open, closed and settled pools with headline money terms | DRAFT pools are hidden |
| Detail | Exact fee and refundable amount; confirmed prize budget and its source; per-selection bonus **estimate** with maximum; a "you can lose the fee" notice; rules; terms hash; server-time countdown | Terms are frozen and hashed |
| Eligibility | Verification form; deposit limit; self-exclusion | PII is encrypted; checks run on every deposit and entry |
| Fund | Simulated checkout and the credited balance | Credit happens only after a verified, de-duplicated callback |
| Enter | Confirmation dialog that restates the fee loss; checkbox accepting the rule version | Locked transaction; server-clock deadline; one entry per account; idempotency key |
| Receipt | Receipt id, selection, amounts, timestamp, rule version, hash, ledger txn | Stored and retrievable at any time |
| Track | Entry status, locked balance, official winner | — |
| Settlement | Itemised statement | Every credit is backed by one balanced ledger transaction |
| Withdraw | Request status and history | Separate from settlement; failures are reversed |

## Operations journey
```mermaid
flowchart LR
  O1[Create funder] --> O2[Create event<br/>+ official source] --> O3[Create DRAFT pool]
  O3 --> O4[Fund prize → escrow] --> O5{Funding check}
  O5 -- confirmed --> O6[Open pool<br/>terms frozen]
  O6 --> O7[Deadline → LOCKED]
  O7 --> O8[Ingest official result] --> O9[Review / disputes]
  O9 --> O10[Confirm result] --> O11[Settlement preview] --> O12[Execute settlement]
  O12 --> O13[Reconciliation & audit]
```

## Pool lifecycle state diagram
```mermaid
stateDiagram-v2
  [*] --> DRAFT: pool created (terms editable)
  DRAFT --> OPEN: prize escrow ≥ budget<br/>(terms frozen)
  DRAFT --> CANCELLED: cancel
  OPEN --> LOCKED: entry deadline (server time)<br/>or result received
  OPEN --> CANCELLED: cancel / postponed beyond window
  LOCKED --> RESULT_REVIEW: official result vN ingested
  LOCKED --> CANCELLED: cancel / postponed beyond window
  RESULT_REVIEW --> DISPUTED: dispute raised
  DISPUTED --> RESULT_REVIEW: all disputes resolved
  RESULT_REVIEW --> RESULT_CONFIRMED: final result confirmed<br/>(no open disputes, window elapsed)
  RESULT_CONFIRMED --> RESULT_REVIEW: correction vN+1 before settlement
  RESULT_CONFIRMED --> DISPUTED: dispute raised
  RESULT_REVIEW --> CANCELLED: cancel
  DISPUTED --> CANCELLED: cancel
  RESULT_CONFIRMED --> CANCELLED: cancel
  RESULT_CONFIRMED --> SETTLING: settlement run persisted
  CANCELLED --> SETTLING: refund run persisted
  SETTLING --> SETTLED: payout complete<br/>(escrow = 0, locked = 0)
  SETTLING --> REFUNDED: full refund complete
  SETTLED --> [*]
  REFUNDED --> [*]
```

Notes:
- A tie, no result, or no correct predictions goes `RESULT_CONFIRMED → SETTLING → REFUNDED`.
- Every transition is a compare-and-set update (`UPDATE … WHERE status = ANY(expected)`). Each one writes an append-only `pool_status_history` row and an audit record.
- `SETTLING` can be resumed. A crashed run is retried and skips lines that were already posted.

## Withdrawal lifecycle
```mermaid
stateDiagram-v2
  [*] --> REQUESTED: hold AVAILABLE→PENDING
  REQUESTED --> PROCESSING: worker claims outbox msg
  PROCESSING --> PAID: provider SUCCEEDED<br/>PENDING→CLEARING
  PROCESSING --> FAILED: provider declined<br/>PENDING→AVAILABLE
  PROCESSING --> PROCESSING: transient error → retry with backoff<br/>(provider idempotent on merchant_ref)
```
