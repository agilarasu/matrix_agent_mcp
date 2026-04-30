import * as React from "react";
import { Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMatrix } from "@/lib/matrix/MatrixProvider";

export function RoomsSidebar(props: { selectedRoomId?: string | null }) {
  const { selectedRoomId } = props;
  const navigate = useNavigate();
  const { client, clientState, session } = useMatrix();
  const [roomsVersion, setRoomsVersion] = React.useState(0);

  const [creating, setCreating] = React.useState(false);
  const [deletingRoomId, setDeletingRoomId] = React.useState<string | null>(null);
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
      setNewRoomName("");
      navigate(`/room/${encodeURIComponent(res.room_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create room failed");
    } finally {
      setCreating(false);
    }
  }

  async function deleteRoom(roomId: string) {
    if (!client) return;
    setError(null);
    setDeletingRoomId(roomId);
    try {
      await client.leave(roomId);
      try {
        await client.forget(roomId, true);
      } catch {
        // Some homeservers may reject forget immediately; leaving is enough to hide from active chats.
      }
      setRoomsVersion((v) => v + 1);
      if (selectedRoomId === roomId) {
        navigate("/");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete chat failed");
    } finally {
      setDeletingRoomId(null);
    }
  }

  return (
    <div className="flex h-svh min-h-svh flex-col border-r bg-white" style={{ borderColor: "var(--divider)" }}>
      <div className="border-b px-4 py-3" style={{ borderColor: "var(--divider)" }}>
        <div className="text-sm font-semibold">Chats</div>
        <div className="truncate text-xs" style={{ color: "var(--text-muted)" }}>
          {session?.userId ?? ""}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {clientState !== "ready" ? (
          <div className="px-4 py-3 text-xs" style={{ color: "var(--text-muted)" }}>
            Connecting… ({clientState})
          </div>
        ) : null}

        <div className="divide-y" style={{ borderColor: "var(--divider)" }}>
          {rooms.length === 0 ? (
            <div className="px-4 py-3 text-sm" style={{ color: "var(--text-muted)" }}>
              No rooms yet.
            </div>
          ) : (
            rooms.map((r) => {
              const selected = selectedRoomId && r.roomId === selectedRoomId;
              const deleting = deletingRoomId === r.roomId;
              return (
                <div
                  key={r.roomId}
                  className="flex items-center gap-2 px-2"
                  style={{ background: selected ? "rgba(37, 211, 102, 0.12)" : undefined }}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left hover:bg-slate-50"
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
                  </button>
                  <button
                    type="button"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    onClick={() => void deleteRoom(r.roomId)}
                    disabled={!client || clientState !== "ready" || deleting}
                    title="Delete chat"
                    aria-label="Delete chat"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="border-t p-3" style={{ borderColor: "var(--divider)" }}>
        <div className="mb-2 text-xs font-medium" style={{ color: "var(--text-muted)" }}>
          New chat
        </div>
        <div className="space-y-2">
          <Input
            className="h-10 rounded-full bg-slate-50 px-4"
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            placeholder="Chat name (optional)"
          />
          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}
          <Button className="h-10 w-full rounded-full" onClick={createRoom} disabled={!client || creating || clientState !== "ready"}>
            {creating ? "Creating..." : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}

