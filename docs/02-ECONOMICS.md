# 2 · Economic model

## Primary model: refundable deposit plus a separately funded prize

Notation, all in integer minor units:

| Symbol | Meaning |
|---|---|
| `D` | Fixed entry deposit |
| `b` | Fee rate in basis points (500 = 5%) |
| `F = round_half_up(D × b / 10000)` | Platform fee per entry (basis: % of deposit) |
| `R = D − F` | Refundable amount per entry |
| `P` | Prize budget, funded by a sponsor or the operator and **escrowed before the pool opens** |
| `N`, `W` | Number of entries, number of correct entries |
| `B = floor(P / W)` | Gross bonus per correct entry |
| `r = P − W·B` | Rounding remainder, returned to the funder (`0 ≤ r < W`) |
| `h` | Withholding rate in bps under a *configured* rule (0 when none is configured) |
| `H = round_half_up(B × h / 10000)` | Withholding per correct entry (applies to the bonus only) |

**Settlement when the result is valid and `W ≥ 1`**
- Every entry: `R` returns to available balance, and `F` goes to fee revenue.
- Correct entries also get `B − H` to available balance, and `H` goes to withholding payable.
- `r` goes back to the funder.

**Full refund cases** (cancelled, unsupported tie, no result, or `W = 0`)
- Every entry gets `D` back. No fee is charged, and all of `P` returns to the funder.

**Two money flows that never mix**
- Deposits flow `USER_LOCKED → USER_AVAILABLE | FEE_REVENUE`.
- Prizes flow `POOL_PRIZE_ESCROW → USER_AVAILABLE | WITHHOLDING_PAYABLE | SPONSOR_AVAILABLE`.

No posting connects a deposit account to an escrow account, so the same money can never fund both a refund and a bonus.

### Invariants (enforced in code and checked by reconciliation)
1. `F + R = D` for every entry. This is a database CHECK on `pools` and `settlement_lines`.
2. `Σ locked deposits in a pool = active entries × D`. Refunds are always fully covered.
3. `Σ bonuses ≤ P`, and the escrow equals `P` while the pool is open.
4. `N·D + P = Σ net credits + Σ fees + Σ withholding + r`, so every minor unit is accounted for.
5. Every ledger transaction sums to zero per currency. A deferred database trigger enforces this.

### Rounding policy
- **Fee and withholding:** round half up to the minor unit. For example, 50.5 → 51 and 50.49 → 50. Because `D` is fixed per pool, `F` is a single fixed number disclosed exactly before entry.
- **Prize split:** round down per winner. The remainder is less than `W` minor units and returns to the funder, so allocations can never exceed funding.
- **Order independence:** lines are computed in a stable order (sorted by entry id), and the result does not depend on it. A property test checks this over 2,000 random pools.

## Fully reconciled numerical example

Configuration: currency USD (**simulated**), `D` = 10.00, fee 5% of the deposit, so `F` = 0.50 and `R` = 9.50. `P` = 100.00, funded by a sponsor. No withholding rule is configured.

Seven participants enter. Three pick the eventual winner (Harbor City FC) and four do not.

This scenario runs in `test/lifecycle.test.js` ("payout: matches the documented worked example") and in `npm run demo`.

### Per-participant outcome
| | Deposit | Fee | Returned deposit | Bonus (gross) | Withholding | **Net credit** | Change vs deposit |
|---|---:|---:|---:|---:|---:|---:|---:|
| Correct (×3) | 10.00 | −0.50 | 9.50 | 33.33 | 0.00 | **42.83** | +32.83 |
| Incorrect (×4) | 10.00 | −0.50 | 9.50 | 0.00 | 0.00 | **9.50** | −0.50 |

Bonus: 100.00 ÷ 3 = 33.333…, which rounds down to **33.33**. Remainder: 100.00 − 99.99 = **0.01**, which returns to the sponsor.

### Pool totals
| Item | Amount |
|---|---:|
| Deposits locked (7 × 10.00) | 70.00 |
| Prize funding escrowed | 100.00 |
| **Money in** | **170.00** |
| Deposits returned (7 × 9.50) | 66.50 |
| Bonuses credited (3 × 33.33) | 99.99 |
| Fees to platform (7 × 0.50) | 3.50 |
| Withholding | 0.00 |
| Prize remainder returned to sponsor | 0.01 |
| **Money out** | **170.00** ✔ |

### Ledger walk-through
Negative amounts are debits and positive amounts are credits. Each row is one balanced transaction.

| # | Transaction | Postings |
|---|---|---|
| 1 | 7 × DEPOSIT (signed provider callback) | PROVIDER_CLEARING −10.00, USER_AVAILABLE(u) +10.00 |
| 2 | PRIZE_FUNDING_RECEIVED | PROVIDER_CLEARING −100.00, SPONSOR_AVAILABLE +100.00 |
| 3 | PRIZE_ESCROWED | SPONSOR_AVAILABLE −100.00, POOL_PRIZE_ESCROW +100.00 |
| 4 | 7 × ENTRY_DEPOSIT_LOCKED | USER_AVAILABLE(u) −10.00, USER_LOCKED(u,pool) +10.00 |
| 5 | 3 × SETTLEMENT_PAYOUT (correct) | USER_LOCKED −0.50 / FEE_REVENUE +0.50; USER_LOCKED −9.50 / USER_AVAILABLE +9.50; POOL_PRIZE_ESCROW −33.33 / USER_AVAILABLE +33.33 |
| 6 | 4 × SETTLEMENT_PAYOUT (incorrect) | USER_LOCKED −0.50 / FEE_REVENUE +0.50; USER_LOCKED −9.50 / USER_AVAILABLE +9.50 |
| 7 | PRIZE_REMAINDER_RETURNED | POOL_PRIZE_ESCROW −0.01, SPONSOR_AVAILABLE +0.01 |

### Account balances
| Account | After funding (1–3) | After entry (4) | After settlement (5–7) |
|---|---:|---:|---:|
| PROVIDER_CLEARING (cash mirror) | −170.00 | −170.00 | −170.00 |
| USER_AVAILABLE (Σ) | 70.00 | 0.00 | **166.49** = 3 × 42.83 + 4 × 9.50 |
| USER_LOCKED (Σ, pool) | 0.00 | 70.00 | 0.00 |
| POOL_PRIZE_ESCROW | 100.00 | 100.00 | 0.00 |
| SPONSOR_AVAILABLE | 0.00 | 0.00 | 0.01 |
| FEE_REVENUE | 0.00 | 0.00 | 3.50 |
| **Sum** | **0.00** | **0.00** | **0.00** ✔ |

The provider's own books show net pay-ins of 170.00, which matches the clearing position. When users withdraw, PROVIDER_CLEARING and the provider's net both fall by the same amount.

### Edge cases using the same pool
| Case | Each entrant receives | Fee revenue | Sponsor gets back |
|---|---:|---:|---:|
| Nobody picked the winner | 10.00 | 0.00 | 100.00 |
| Event cancelled / postponed beyond window | 10.00 | 0.00 | 100.00 |
| Tie, and the pool has no "draw" selection | 10.00 | 0.00 | 100.00 |
| Single correct entrant | winner 9.50 + 100.00; others 9.50 | 3.50 | 0.00 |

### Withholding mechanics (illustration only)
No tax rate is assumed anywhere in the product. If a jurisdiction-specific rule were configured, for example a **hypothetical** 10% of bonus used in tests only to exercise the arithmetic, a 33.33 bonus would have 3.33 withheld (3.333 rounds half-up to 3.33). That amount would post to WITHHOLDING_PAYABLE, and the statement would show a net credit of 39.50. Withheld amounts are a liability held for remittance under that rule. They are never platform revenue and are never described as a government tax collected by the platform.

### Who bears what (refundable model)
- **Participant:** the maximum loss is the fee (0.50). There is no guaranteed profit, because the bonus depends on being right and on how many others were right.
- **Sponsor:** cost is at most `P`, and less by the remainder or by the whole budget in a refund case. This is a marketing spend, fixed in advance.
- **Platform:** revenue is `N × F`, which is zero in refund cases. The platform carries no outcome risk.

## Alternative model: conventional pari-mutuel (not implemented)
In a pari-mutuel pool, stakes are **not** refundable. The operator deducts a takeout, and the remaining net pool is shared among correct entrants.

| Item | Same 7 entries, 3 correct, 10.00 stake, 5% takeout of gross pool |
|---|---:|
| Gross pool | 70.00 |
| Takeout (operator) | 3.50 |
| Net pool | 66.50 |
| Payout per winner, rounded down | 22.16 (+12.16 profit) |
| Breakage (66.50 − 66.48) | 0.02 |
| Loser outcome | −10.00 (whole stake lost) |

**How the models differ**
- In pari-mutuel, winners are paid **from losers' stakes**. There is no external prize fund and no refund.
- The refundable model returns `R` to everyone, and winners are paid **only** from the external escrow.
- The two are kept as separate models. Pari-mutuel exists only as the pure function `economics.pariMutuel()` for comparison, and the `pools.model` column allows only `REFUNDABLE`. Adding pari-mutuel later would need its own account types (e.g. `POOL_STAKES`), settlement code and disclosures. It must never reuse escrow accounts.
- Pari-mutuel is conventionally treated as wagering and would need the corresponding licensing.
