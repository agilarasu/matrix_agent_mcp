import React from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMatrix } from "@/lib/matrix/MatrixProvider";

export function RoomsPage() {
  const navigate = useNavigate();
  const { client, clientState, logout, session } = useMatrix();
  const [roomsVersion, setRoomsVersion] = React.useState(0);

  const [creating, setCreating] = React.useState(false);
  const [newRoomName, setNewRoomName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const inviteBotMxid = (import.meta.env.VITE_DEFAULT_INVITE_BOT_MXID as string | undefined)?.trim() || "@agil_ai_bot:matrix.org";

  React.useEffect(() => {
    if (!client) return;
    const onRoom = () => setRoomsVersion((v) => v + 1);
    client.on("Room" as never, onRoom as never);
    return () => {
      client.off("Room" as never, onRoom as never);
    };
  }, [client]);

  const rooms = React.useMemo(() => {
    const list = client?.getRooms() ?? [];
    return [...list].sort((a, b) => (a.name || a.roomId).localeCompare(b.name || b.roomId));
  }, [client, roomsVersion]);

  function roomInitial(nameOrId: string) {
    const s = (nameOrId || "").trim();
    const ch = s.replace(/^#/, "").charAt(0) || "?";
    return ch.toUpperCase();
  }

  async function createRoom() {
    if (!client) return;
    setError(null);
    setCreating(true);
    try {
      const res = await client.createRoom({
        visibility: "private" as any,
        preset: "private_chat" as any,
        name: newRoomName || undefined,
        invite: [inviteBotMxid],
      });
      navigate(`/room/${encodeURIComponent(res.room_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create room failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-3 py-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[16px] font-semibold leading-6">Chats</div>
          <div className="truncate text-[12px]" style={{ color: "var(--text-muted)" }}>
            Signed in as {session?.userId ?? ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => navigate("/login")}>
            Switch
          </Button>
          <Button variant="outline" onClick={logout}>
            Logout
          </Button>
        </div>
      </div>

      {clientState !== "ready" ? (
        <div className="mb-4 rounded-2xl border bg-white p-4" style={{ borderColor: "var(--divider)" }}>
          <div className="text-sm font-medium">Connecting…</div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            Matrix client state: {clientState}
          </div>
        </div>
      ) : null}

      <div className="rounded-2xl border bg-white" style={{ borderColor: "var(--divider)" }}>
        <div className="border-b px-4 py-3" style={{ borderColor: "var(--divider)" }}>
          <div className="text-sm font-semibold">Joined rooms</div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            Tap room to open chat.
          </div>
        </div>
        <div className="divide-y" style={{ borderColor: "var(--divider)" }}>
          {rooms.length === 0 ? (
            <div className="px-4 py-4 text-sm" style={{ color: "var(--text-muted)" }}>
              No rooms yet.
            </div>
          ) : (
            rooms.map((r) => (
              <button
                key={r.roomId}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
                onClick={() => navigate(`/room/${encodeURIComponent(r.roomId)}`)}
              >
                <div
                  className="grid h-10 w-10 place-items-center rounded-full text-sm font-semibold"
                  style={{ background: "#eef2ff", color: "#3730a3" }}
                >
                  {roomInitial(r.name || r.roomId)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.name || "Unnamed chat"}</div>
                </div>
                <div className="shrink-0 text-xs" style={{ color: "var(--text-muted)" }}>
                  {r.getMyMembership() ?? ""}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="mt-4 rounded-2xl border bg-white p-4" style={{ borderColor: "var(--divider)" }}>
        <div className="mb-3">
          <div className="text-sm font-semibold">New chat</div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            Create private room. Bot invite is always enabled.
          </div>
        </div>
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              Room name
            </div>
            <Input
              className="h-11 rounded-full bg-slate-50 px-4"
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="Chat name (optional)"
            />
          </div>
          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}
          <Button className="h-11 rounded-full px-5" onClick={createRoom} disabled={!client || creating || clientState !== "ready"}>
            {creating ? "Creating..." : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}

