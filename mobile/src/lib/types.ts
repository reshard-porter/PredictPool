// Response shapes of the PredictPool API (see docs/06-API.md). Money is integer minor units.
export type PoolStatus = 'OPEN' | 'LOCKED' | 'RESULT_REVIEW' | 'DISPUTED' | 'RESULT_CONFIRMED' | 'CANCELLED' | 'SETTLING' | 'SETTLED' | 'REFUNDED';

export interface AppConfig { currency: string; exponent: number; fundsMode: string; jurisdiction: string; demoMode: boolean; withholdingRule: string }

export interface BonusEstimate { maximumGrossMinor: number; estimateGrossMinor: number; estimateWithholdingMinor: number; basis: string; isEstimate: true }
export interface Selection { id: string; code: string; label: string; picks: number; bonusEstimate: BonusEstimate }
export interface Pool {
  id: string; name: string; status: PoolStatus; model: string; fundsMode: string;
  event: { id: string; name: string; kind: 'MATCH' | 'TOURNAMENT'; sport: string; startsAt: string; status: string; officialSource: string };
  currency: string; entryDeadline: string; serverTime: string;
  disclosure: { depositMinor: number; feeMinor: number; feeBps: number; feeBasis: string; refundableMinor: number; prizeBudgetMinor: number;
    prizeSource: string; withholdingRule: string; withholdingBps: number; youCanLose: string };
  selections: Selection[]; entries: number; maxEntries: number; rulesVersion: string; termsHash: string; settlementRules: string[];
  postponementWindowHours: number; winningSelectionId: string | null; settlementOutcome: 'PAYOUT' | 'FULL_REFUND' | null; settlementReason: string | null;
  myEntry: { id: string; selectionId: string; status: string; acceptedAt: string } | null;
}
export interface Receipt {
  receiptId: string; entryId: string; poolId: string; poolName: string; selection: { id: string; code: string; label: string };
  currency: string; depositMinor: number; feeMinor: number; refundableMinor: number; prizeBudgetMinor: number;
  acceptedAt: string; rulesVersion: string; termsHash: string; ledgerTransactionId: string; status: string; fundsMode: string;
}
export interface MyEntry {
  entryId: string; poolId: string; poolName: string; poolStatus: PoolStatus; eventName: string; eventStartsAt: string; selection: string;
  status: string; currency: string; depositMinor: number; feeMinor: number; refundableMinor: number; acceptedAt: string;
  settled: boolean; isCorrect: boolean | null; netCreditMinor: number | null;
}
export interface Statement {
  entryId: string; poolName: string; selection: string; currency: string; outcome: 'PAYOUT' | 'FULL_REFUND'; reason: string;
  isCorrect: boolean; settledAt: string; ledgerTransactionId: string;
  items: { label: string; amountMinor: number; subtotal?: boolean; total?: boolean }[];
}
export interface Balances { currency: string; availableMinor: number; lockedMinor: number; pendingWithdrawalMinor: number }
export interface Profile { id: string; email: string; displayName: string; verificationStatus: 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';
  jurisdiction: string | null; selfExcludedUntil: string | null; dailyDepositLimitMinor: number | null; documentMasked: string | null }
export interface Me { profile: Profile; balances: Balances }
export interface Withdrawal { withdrawalId: string; status: 'REQUESTED' | 'PROCESSING' | 'PAID' | 'FAILED'; amountMinor: number; currency: string;
  failureReason: string | null; attempts: number; createdAt: string }
export interface LedgerLine { transactionId: string; type: string; description: string; at: string; account: string; amountMinor: number }
