import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { Session } from '../api/types';

interface SessionValue {
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<Session>;
  signOut: () => Promise<void>;
  isStaff: boolean;
  canOperate: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.me()
      .then((value) => { if (!cancelled) setSession(value); })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) setSession(null);
        else setSession(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const value = await api.login(email, password);
    setSession(value);
    return value;
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setSession(null);
  }, []);

  const value = useMemo<SessionValue>(() => ({
    session,
    loading,
    signIn,
    signOut,
    isStaff: session ? session.role !== 'PARTICIPANT' : false,
    // VIEWER may watch the board but never mutate the running event.
    canOperate: session ? session.role === 'OWNER' || session.role === 'ADMIN' : false,
  }), [session, loading, signIn, signOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
