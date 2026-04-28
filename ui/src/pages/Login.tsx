import React from "react";
import { createClient } from "matrix-js-sdk";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { saveSession, type MatrixSession } from "@/lib/storage";
import { useMatrix } from "@/lib/matrix/MatrixProvider";

export function LoginPage() {
  const navigate = useNavigate();
  const { session, setSession } = useMatrix();

  const [homeserverUrl, setHomeserverUrl] = React.useState(
    session?.homeserverUrl ?? (import.meta.env.VITE_MATRIX_HOMESERVER_URL as string | undefined) ?? "http://localhost:8008"
  );
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const client = createClient({ baseUrl: homeserverUrl });
      const res = (await client.login("m.login.password", {
        user: username,
        password,
      })) as unknown as { access_token: string; user_id: string; device_id?: string };

      const next: MatrixSession = {
        homeserverUrl,
        accessToken: res.access_token,
        userId: res.user_id,
        deviceId: res.device_id,
      };
      saveSession(next);
      setSession(next);
      navigate("/rooms", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md items-center px-3 py-8">
      <Card className="w-full rounded-2xl">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Matrix password login.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={onSubmit}>
            <div className="space-y-1">
              <div className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                Homeserver URL
              </div>
              <Input
                className="h-11 rounded-full bg-slate-50 px-4"
                value={homeserverUrl}
                onChange={(e) => setHomeserverUrl(e.target.value)}
                placeholder="http://localhost:8008"
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                Username
              </div>
              <Input
                className="h-11 rounded-full bg-slate-50 px-4"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="@alice:example.org or alice"
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                Password
              </div>
              <Input
                className="h-11 rounded-full bg-slate-50 px-4"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            ) : null}
            <Button className="h-11 w-full rounded-full" type="submit" disabled={busy || !homeserverUrl || !username || !password}>
              {busy ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

