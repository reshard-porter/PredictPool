import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import type { AppConfig, Me, MyEntry, Pool, Receipt, Statement, Withdrawal, LedgerLine } from './types';

/**
 * Resolve the API origin:
 *  1. EXPO_PUBLIC_API_URL if set (use HTTPS in any real deployment)
 *  2. web build → same host as the page, port 3000
 *  3. dev on a device/emulator → the Metro host's LAN IP, port 3000
 *  4. Android emulator fallback → 10.0.2.2 (host loopback)
 */
function resolveBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (Platform.OS === 'web' && typeof window !== 'undefined') return `${window.location.protocol}//${window.location.hostname}:3000`;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host) return `http://${host}:3000`;
  return Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000';
}
export const API_URL = resolveBaseUrl();

export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number, public details?: unknown) { super(message); }
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;
export const setApiToken = (t: string | null) => { token = t; };
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };
export const newIdempotencyKey = () => Crypto.randomUUID();

async function request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(`Can't reach the server at ${API_URL}. Check your connection.`, 'NETWORK', 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token && onUnauthorized) onUnauthorized();
    const e = (json as { error?: { code: string; message: string; details?: unknown } }).error;
    throw new ApiError(e?.message ?? res.statusText, e?.code ?? 'HTTP_' + res.status, res.status, e?.details);
  }
  return json as T;
}

export const api = {
  config: () => request<AppConfig>('GET', '/config'),
  register: (b: { email: string; password: string; displayName: string }) => request<{ id: string }>('POST', '/auth/register', b),
  login: (b: { email: string; password: string }) => request<{ token: string; userId: string }>('POST', '/auth/login', b),
  me: () => request<Me>('GET', '/me'),
  verify: (b: { fullName: string; dateOfBirth: string; documentNumber: string; jurisdiction: string }) =>
    request<{ status: string; reasons: string[] }>('POST', '/me/verification', b),
  setLimit: (dailyDepositLimitMinor: number) => request<{ dailyDepositLimitMinor: number }>('PUT', '/me/limits', { dailyDepositLimitMinor }),
  selfExclude: (days: number) => request<{ selfExcludedUntil: string }>('POST', '/me/self-exclusion', { days }),
  pools: () => request<Pool[]>('GET', '/pools'),
  pool: (id: string) => request<Pool>('GET', `/pools/${id}`),
  enter: (poolId: string, b: { selectionId: string; acceptedRulesVersion: string; acceptedTermsHash: string }, key: string) =>
    request<Receipt>('POST', `/pools/${poolId}/entries`, b, key),
  myEntries: () => request<MyEntry[]>('GET', '/me/entries'),
  receipt: (entryId: string) => request<Receipt>('GET', `/entries/${entryId}/receipt`),
  statement: (entryId: string) => request<Statement>('GET', `/entries/${entryId}/settlement`),
  dispute: (poolId: string, reason: string) => request<{ id: string }>('POST', `/pools/${poolId}/disputes`, { reason }),
  createDeposit: (amountMinor: number, key: string) =>
    request<{ depositId: string; status: string; amountMinor: number }>('POST', '/wallet/deposits', { amountMinor }, key),
  simulateCheckout: (depositId: string) => request<{ status: string }>('POST', `/wallet/deposits/${depositId}/simulate-checkout`, {}),
  withdraw: (amountMinor: number, key: string) => request<Withdrawal>('POST', '/wallet/withdrawals', { amountMinor }, key),
  withdrawals: () => request<Withdrawal[]>('GET', '/wallet/withdrawals'),
  transactions: () => request<LedgerLine[]>('GET', '/wallet/transactions'),
};
