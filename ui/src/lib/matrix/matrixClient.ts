import { createClient, type MatrixClient } from "matrix-js-sdk";
import { loadSession, type MatrixSession } from "@/lib/storage";

export type ClientState = "idle" | "starting" | "ready" | "error";

export function createMatrixClientFromSession(
  session: MatrixSession
): MatrixClient {
  return createClient({
    baseUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
  });
}

export function createMatrixClientFromStoredSession(): MatrixClient | null {
  const session = loadSession();
  if (!session) return null;
  return createMatrixClientFromSession(session);
}

