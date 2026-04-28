export type MatrixSession = {
  homeserverUrl: string;
  userId: string;
  deviceId?: string;
  accessToken: string;
};

const KEY = "matrix_poc_session_v1";

export function loadSession(): MatrixSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as MatrixSession;
  } catch {
    return null;
  }
}

export function saveSession(session: MatrixSession) {
  localStorage.setItem(KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(KEY);
}

