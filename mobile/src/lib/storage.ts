import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// Session token lives in the iOS Keychain / Android Keystore. expo-secure-store has no web
// implementation, so the browser build keeps it in sessionStorage (cleared with the tab).
const KEY = 'pp_session';

export async function loadToken(): Promise<string | null> {
  if (Platform.OS === 'web') {
    try { return globalThis.sessionStorage?.getItem(KEY) ?? null; } catch { return null; }
  }
  return SecureStore.getItemAsync(KEY);
}

export async function saveToken(token: string | null): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (token) globalThis.sessionStorage?.setItem(KEY, token);
      else globalThis.sessionStorage?.removeItem(KEY);
    } catch { /* storage unavailable */ }
    return;
  }
  if (token) await SecureStore.setItemAsync(KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  else await SecureStore.deleteItemAsync(KEY);
}
