import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setApiToken, setUnauthorizedHandler } from './api';
import { setCurrency } from './money';
import { loadToken, saveToken } from './storage';
import type { AppConfig, Me } from './types';

interface Session {
  ready: boolean; signedIn: boolean; me: Me | null; config: AppConfig | null;
  signIn: (email: string, password: string) => Promise<void>;
  register: (displayName: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<Me | null>;
}
const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);

  const apply = useCallback(async (t: string | null) => {
    setApiToken(t); setToken(t); await saveToken(t);
    if (!t) setMe(null);
  }, []);

  const refresh = useCallback(async () => {
    try { const m = await api.me(); setMe(m); return m; } catch { return null; }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { void apply(null); });
    (async () => {
      try { const c = await api.config(); setConfig(c); setCurrency(c.currency, c.exponent); } catch { /* offline: screens show errors */ }
      const t = await loadToken();
      if (t) { setApiToken(t); setToken(t); await refresh(); }
      setReady(true);
    })();
  }, [apply, refresh]);

  const value = useMemo<Session>(() => ({
    ready, signedIn: Boolean(token), me, config,
    signIn: async (email, password) => { const r = await api.login({ email, password }); await apply(r.token); await refresh(); },
    register: async (displayName, email, password) => {
      await api.register({ email, password, displayName });
      const r = await api.login({ email, password }); await apply(r.token); await refresh();
    },
    signOut: () => apply(null),
    refresh,
  }), [ready, token, me, config, apply, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession must be used inside SessionProvider');
  return s;
}
