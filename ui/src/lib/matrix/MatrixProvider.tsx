import React from "react";
import type { MatrixClient } from "matrix-js-sdk";

import { clearSession, loadSession, type MatrixSession } from "@/lib/storage";
import {
  createMatrixClientFromSession,
  type ClientState,
} from "@/lib/matrix/matrixClient";

type MatrixContextValue = {
  session: MatrixSession | null;
  client: MatrixClient | null;
  clientState: ClientState;
  logout: () => void;
  setSession: (session: MatrixSession) => void;
};

const MatrixContext = React.createContext<MatrixContextValue | null>(null);

export function MatrixProvider({ children }: { children: React.ReactNode }) {
  const [session, setSessionState] = React.useState<MatrixSession | null>(() =>
    typeof window === "undefined" ? null : loadSession()
  );
  const [clientState, setClientState] = React.useState<ClientState>("idle");
  const [client, setClient] = React.useState<MatrixClient | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let localClient: MatrixClient | null = null;
    async function start() {
      if (!session) {
        setClient(null);
        setClientState("idle");
        return;
      }

      setClientState("starting");
      const next = createMatrixClientFromSession(session);
      localClient = next;
      setClient(next);

      try {
        next.startClient({ initialSyncLimit: 20 });
        await new Promise<void>((resolve, reject) => {
          const onSync = (state: string) => {
            if (state === "PREPARED") {
              next.off("sync" as never, onSync as never);
              resolve();
            }
            if (state === "ERROR") {
              next.off("sync" as never, onSync as never);
              reject(new Error("Matrix sync error"));
            }
          };
          next.on("sync" as never, onSync as never);
        });
        if (!cancelled) setClientState("ready");
      } catch {
        if (!cancelled) setClientState("error");
      }
    }
    void start();
    return () => {
      cancelled = true;
      try {
        localClient?.stopClient();
      } catch {
        // ignore
      }
    };
  }, [session]);

  const logout = React.useCallback(() => {
    try {
      client?.stopClient();
    } catch {
      // ignore
    }
    clearSession();
    setSessionState(null);
    setClient(null);
    setClientState("idle");
  }, [client]);

  const setSession = React.useCallback((next: MatrixSession) => {
    setSessionState(next);
  }, []);

  const value: MatrixContextValue = {
    session,
    client,
    clientState,
    logout,
    setSession,
  };

  return <MatrixContext.Provider value={value}>{children}</MatrixContext.Provider>;
}

export function useMatrix() {
  const ctx = React.useContext(MatrixContext);
  if (!ctx) throw new Error("useMatrix must be used within MatrixProvider");
  return ctx;
}

