// SPDX-License-Identifier: AGPL-3.0-only
/** Session state: who is logged in and what they may do (display only; the server enforces). */
import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { permissionsResponse, sessionInfo, type PermissionsResponse, type SessionInfo } from '@opendc/shared/api';
import { api, ApiFailure, setCsrfToken } from './api.ts';

export interface SessionState {
  session: SessionInfo | null;
  permissions: PermissionsResponse['permissions'];
  has: (permission: string) => boolean;
  loading: boolean;
  /** Set when the session check failed for a reason other than "not logged in". */
  error: unknown;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

async function loadSession(): Promise<{
  session: SessionInfo;
  permissions: PermissionsResponse['permissions'];
} | null> {
  try {
    const session = await api('/session', { schema: sessionInfo });
    setCsrfToken(session.csrfToken);
    const { permissions } = await api('/session/permissions', { schema: permissionsResponse });
    return { session, permissions };
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 401) {
      setCsrfToken(null);
      return null;
    }
    throw e;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['session'], queryFn: loadSession, retry: false, staleTime: 60_000 });
  const permissions = q.data?.permissions ?? [];
  const value: SessionState = {
    session: q.data?.session ?? null,
    permissions,
    has: (p) => permissions.some((x) => x.permission === p),
    loading: q.isPending,
    error: q.error,
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['session'] });
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
