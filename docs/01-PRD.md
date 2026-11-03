# 1 · Product requirements: PredictPool MVP

## Summary
PredictPool lets verified users join a **pool** for a match or tournament, lock a fixed **deposit**, and predict the winner before the entry deadline. After the official result is final, **every participant gets back their deposit minus a disclosed platform fee**. Participants who predicted correctly also share a **separately funded prize budget** put up by a sponsor or the operator. Participant deposits never fund prizes, and prize money never funds refunds.

The MVP uses **simulated funds only**. Live payments stay disabled in code (`assertLivePaymentsAllowed`) until the open decisions below are resolved.

## Goals
- Show users exactly what they put in, what they can lose (the fee), and what they could win (an estimate) before they enter.
- Make every money movement traceable to a balanced, append-only ledger transaction.
- Keep refunds fully covered by locked deposits, and keep prizes within confirmed funding.
- Give operations a controlled, audited workflow from pool creation to settlement.

## Non-goals (MVP)
Live money, multiple currencies in one pool, odds or pari-mutuel pools, in-play entries, multiple entries per account, co-winner (dead-heat) splits, native mobile apps, and notification delivery. The notification hooks exist as outbox topics.

## Users and roles
| Actor | Capabilities |
|---|---|
| Participant | Register, verify, set deposit limit, self-exclude, fund, enter, dispute, view receipts and statements, withdraw |
| OPS admin | Create funders, events and pools; open and cancel pools; postpone events |
| RESULTS admin | Publish and ingest official results, confirm results, raise and resolve disputes |
| FINANCE admin | Confirm prize funding, preview and execute settlement, control the simulated payout provider |
| AUDITOR | Read-only access to audit log and reconciliation |

All admin sessions require a password plus TOTP MFA. Roles are enforced on every admin endpoint.

## Functional requirements
1. **Browse:** list open and closed pools with deposit, fee, refundable amount, prize budget, deadline and entry count.
2. **Disclose:** before entry, show the fee basis and amount, the refundable amount, the confirmed prize budget and its source, the withholding rule, settlement rules, the rule version and terms hash, plus a per-selection bonus **estimate** labelled as an estimate.
3. **Eligibility:** identity verification through the simulated KYC provider (minimum age, eligible jurisdiction, document check), user-set deposit limit, platform balance cap, and self-exclusion. Self-exclusion blocks deposits and entries but not withdrawals.
4. **Fund:** create a pending deposit, then complete a simulated checkout. The balance is credited only after a **signed** provider callback arrives.
5. **Enter:** one entry per account per pool. The deadline is enforced with the database clock inside a locked transaction. The accepted rule version and terms hash must match the pool's frozen terms.
6. **Receipt:** selection, deposit, fee, refundable amount, server timestamp, rule version, terms hash and ledger transaction id.
7. **Track:** entry status, locked deposit, pool status and the official result.
8. **Settle:** itemised statement showing deposit, fee, returned deposit, gross bonus, withholding and net credit.
9. **Withdraw:** a separate flow from settlement. Funds are held and paid through the simulated provider. A failed payout returns the funds to the user.
10. **Operations:** create pools; check funding (a pool cannot open without confirmed escrow); review results; handle disputes; preview settlement; execute settlement; review reconciliation and audit history.

## Business rules
- Server time and transactional checks decide whether an entry is late.
- Prize funding must be confirmed in escrow before a pool opens.
- Financial terms freeze when the pool leaves DRAFT. A database trigger enforces this.
- Results are accepted only from the event's documented official source. Each result is an immutable version.
- An open dispute puts the pool in DISPUTED, and settlement is refused until it is resolved.
- A cancelled event, an unsupported tie, no result, or no correct predictions gives every entrant a **full deposit refund with no fee**. The prize budget goes back to the funder.
- **Postponement:** if the rescheduled start is within the pool's window (default 72 h) of the original start, the pool stays valid. Beyond that, the pool is cancelled and everyone is refunded in full.
- **Disqualification:** the official source's final classification at settlement time decides the winner.
- **Result correction:** a correction received before settlement creates a new version and returns the pool to review. After settlement, results are final and money is not reversed. The ignored correction is audited, and any goodwill payment would be a separate operator-funded transaction.
- **Sponsor refund:** the unallocated prize (rounding remainder, no winners, or cancellation) returns to the funder in the same settlement.
- **Rounding:** fee and withholding round half-up to the minor unit. The prize split rounds down per winner, and the remainder goes to the funder.
- Withdrawal processing is independent of pool settlement.

## Assumptions (demo defaults; every one is configurable)
| Placeholder | Demo value | Where |
|---|---|---|
| Launch jurisdiction | **not configured**; eligibility uses the simulated region `DEMO` | `src/config.js` |
| Currency | USD, exponent 2, **simulated** | `CURRENCY` |
| Fixed entry amount | 10.00 (1000 minor units) | `ENTRY_AMOUNT_MINOR` |
| Platform fee | 5% of the deposit, half-up, so 0.50 | `FEE_BPS`, `feeBasis` |
| Prize source | Fictional sponsor; the operator is also supported | per pool |
| Withholding | `NONE_CONFIGURED` (0). **No rate is invented.** | `config.withholding` |
| Minimum age | 18, as a placeholder | `MIN_AGE` |
| Daily deposit limit / balance cap | 500.00 / 5,000.00 | config |

## Open decisions (they block a live launch)
1. **Regulatory classification.** Fee-bearing entry plus a prize decided by a sports outcome may be regulated as gambling, a sweepstakes, or a skill contest depending on the jurisdiction. This needs legal review, which this document does not provide.
2. Jurisdiction(s), licensing, age threshold and geolocation requirements.
3. Payment provider, approval for this use case, and the custody model (segregated client account or trust).
4. Tax treatment of prizes and fees, withholding and reporting obligations, and how fee revenue is treated for indirect tax.
5. Approved official data source and its licence for each sport.
6. KYC/AML vendor, thresholds, and sanctions screening.
7. Policy for dormant balances, chargebacks and negative-balance recovery.
8. Whether tied outcomes should become a supported selection (e.g. "Draw") for some sports.
9. Sponsor contracts: funding timing, clawback, and what happens if a sponsor fails before the pool opens.
10. Responsible-play features beyond the MVP: cool-off periods, reality checks, and loss limits.
