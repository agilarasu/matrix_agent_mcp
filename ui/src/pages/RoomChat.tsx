import React from "react";
import type { MatrixEvent } from "matrix-js-sdk";
import { RoomEvent } from "matrix-js-sdk/lib/models/room";
import { useParams } from "react-router-dom";

import { ChoiceSelectorCard } from "@/components/ChoiceSelectorCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMatrix } from "@/lib/matrix/MatrixProvider";
import {
  MATRIX_EVENT_CHOICE_RESULT,
  MATRIX_EVENT_CHOICE_SELECTOR,
  type ChoiceResultEventContent,
  type ChoiceSelectorEventContent,
} from "@/lib/matrix/types";
import { cn } from "@/lib/utils";

type RenderableEvent =
  | { kind: "text"; event: MatrixEvent; body: string }
  | { kind: "choice_selector"; event: MatrixEvent; content: ChoiceSelectorEventContent }
  | { kind: "choice_result"; event: MatrixEvent; content: ChoiceResultEventContent };

function eventSender(event: MatrixEvent): string {
  return event.getSender?.() ?? (event as any).sender ?? "";
}

function eventTs(event: MatrixEvent): number {
  return event.getTs?.() ?? (event as any).origin_server_ts ?? 0;
}

function toRenderable(ev: MatrixEvent): RenderableEvent | null {
  const type = ev.getType();
  if (type === "m.room.message") {
    const c = ev.getContent() as { msgtype?: string; body?: string };
    if (c?.msgtype !== "m.text") return null;
    const body = c?.body ?? "";
    return { kind: "text", event: ev, body };
  }
  if (type === MATRIX_EVENT_CHOICE_SELECTOR) {
    const c = ev.getContent() as ChoiceSelectorEventContent;
    if (!c?.request_id || !c?.prompt || !Array.isArray(c?.options)) return null;
    return { kind: "choice_selector", event: ev, content: c };
  }
  if (type === MATRIX_EVENT_CHOICE_RESULT) {
    const c = ev.getContent() as ChoiceResultEventContent;
    if (!c?.request_id || !Array.isArray(c?.selected_option_ids) || !c?.submitted_by) return null;
    return { kind: "choice_result", event: ev, content: c };
  }
  return null;
}

function derivePendingChoice(events: RenderableEvent[], userId: string | undefined) {
  if (!userId) return null;
  const selectors = events.filter((e) => e.kind === "choice_selector") as Array<
    Extract<RenderableEvent, { kind: "choice_selector" }>
  >;
  if (selectors.length === 0) return null;
  const latest = selectors[selectors.length - 1];
  const requestId = latest.content.request_id;

  const results = events.filter((e) => e.kind === "choice_result") as Array<
    Extract<RenderableEvent, { kind: "choice_result" }>
  >;
  const hasUserResult = results.some(
    (r) => r.content.request_id === requestId && r.content.submitted_by === userId
  );
  return hasUserResult ? null : requestId;
}

export function RoomChatPage() {
  const { roomId: roomIdParam } = useParams();
  const roomId = roomIdParam ? decodeURIComponent(roomIdParam) : null;
  const { client, clientState, session } = useMatrix();

  const [events, setEvents] = React.useState<MatrixEvent[]>([]);
  const [message, setMessage] = React.useState("");
  const [sendBusy, setSendBusy] = React.useState(false);
  const [roomTick, setRoomTick] = React.useState(0);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = React.useRef(true);

  function eventKey(ev: MatrixEvent): string {
    const id = ev.getId?.();
    if (id) return id;
    const type = ev.getType();
    const sender = eventSender(ev);
    const ts = eventTs(ev);
    const c = ev.getContent?.() ?? {};
    const body = typeof (c as any).body === "string" ? (c as any).body : "";
    return `${type}:${sender}:${ts}:${body}`;
  }

  function dedupeAppend(prev: MatrixEvent[], next: MatrixEvent) {
    const key = eventKey(next);
    if (prev.some((p) => eventKey(p) === key)) return prev;
    return [...prev, next];
  }

  React.useEffect(() => {
    if (!client || !roomId) return;
    if (clientState !== "ready") return;
    const c = client;
    const room = c.getRoom(roomId);
    if (!room) {
      const onRoom = (r: any) => {
        if (r?.roomId === roomId) setRoomTick((t) => t + 1);
      };
      c.on("Room" as any, onRoom as any);
      return () => {
        c.off("Room" as any, onRoom as any);
      };
    }
    const roomNonNull = room;

    let cancelled = false;
    async function prime() {
      try {
        await c.scrollback(roomNonNull, 30);
      } catch {
        // ignore
      }
      if (cancelled) return;
      const live = roomNonNull.getLiveTimeline().getEvents();
      // dedupe defensive: matrix-js-sdk can emit same event multiple times (local echo, timeline updates)
      const map = new Map<string, MatrixEvent>();
      for (const ev of live) map.set(eventKey(ev), ev);
      setEvents([...map.values()]);
    }
    void prime();

    const onTimeline = (
      ev: MatrixEvent,
      r: (typeof roomNonNull) | undefined,
      toStartOfTimeline?: boolean
    ) => {
      if (r?.roomId !== roomId) return;
      if (toStartOfTimeline) return;
      setEvents((prev) => dedupeAppend(prev, ev));
    };
    c.on(RoomEvent.Timeline, onTimeline as any);
    return () => {
      cancelled = true;
      c.off(RoomEvent.Timeline, onTimeline as any);
    };
  }, [client, clientState, roomId, roomTick]);

  const renderable = React.useMemo(() => {
    const list = events.map(toRenderable).filter(Boolean) as RenderableEvent[];
    return list.sort((a, b) => eventTs(a.event) - eventTs(b.event));
  }, [events]);

  const pendingRequestId = React.useMemo(
    () => derivePendingChoice(renderable, session?.userId),
    [renderable, session?.userId]
  );

  const composerDisabled = clientState !== "ready" || !client || !roomId || Boolean(pendingRequestId);

  const room = client && roomId ? client.getRoom(roomId) : null;

  async function sendText() {
    if (!client || !roomId) return;
    const body = message.trim();
    if (!body) return;
    setSendBusy(true);
    try {
      await client.sendTextMessage(roomId, body);
      setMessage("");
    } finally {
      setSendBusy(false);
    }
  }

  async function submitChoice(requestId: string, selectedOptionIds: string[]) {
    if (!client || !roomId || !session?.userId) return;
    const content: ChoiceResultEventContent = {
      request_id: requestId,
      selected_option_ids: selectedOptionIds,
      submitted_by: session.userId,
    };
    await client.sendEvent(roomId, MATRIX_EVENT_CHOICE_RESULT as any, content as any);
  }

  const activeChoice = React.useMemo(() => {
    const latest = [...renderable]
      .filter((e) => e.kind === "choice_selector")
      .slice(-1)[0] as Extract<RenderableEvent, { kind: "choice_selector" }> | undefined;
    if (!latest) return null;
    if (pendingRequestId && latest.content.request_id === pendingRequestId) return latest;
    return null;
  }, [renderable, pendingRequestId]);

  const myChoiceResultsByRequestId = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of renderable) {
      if (e.kind !== "choice_result") continue;
      if (!session?.userId) continue;
      if (e.content.submitted_by !== session.userId) continue;
      map.set(e.content.request_id, e.content.selected_option_ids);
    }
    return map;
  }, [renderable, session?.userId]);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      shouldStickToBottomRef.current = distanceFromBottom < 120;
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (!shouldStickToBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [renderable.length, activeChoice != null]);

  return (
    <div className="flex h-svh min-h-svh w-full flex-col">
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto px-3 py-4"
        style={{
          backgroundColor: "var(--chat-bg)",
          backgroundImage:
            "radial-gradient(circle at 12px 12px, var(--chat-bg-dot) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      >
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {renderable.length === 0 ? (
            <div className="text-center text-sm" style={{ color: "var(--text-muted)" }}>
              No messages yet.
            </div>
          ) : null}

          {renderable.map((e) => {
            const sender = eventSender(e.event);
            const isMe = sender && sender === session?.userId;

            if (e.kind === "choice_result") {
              // shown via corresponding selector card (read-only) to avoid duplicate bubbles
              return null;
            }

            if (e.kind === "choice_selector") {
              // render active selector as special card below; older ones stay as normal bubble
              if (pendingRequestId && e.content.request_id === pendingRequestId) return null;
            }

            if (e.kind === "choice_selector") {
              const submitted = myChoiceResultsByRequestId.get(e.content.request_id) ?? null;
              return (
                <div key={e.event.getId() ?? `${eventTs(e.event)}:${sender}`} className="flex justify-center">
                  <div className="w-full max-w-[520px]">
                    <ChoiceSelectorCard
                      content={e.content}
                      readOnly={Boolean(submitted)}
                      selectedOptionIds={submitted ?? undefined}
                      onSubmit={async () => {}}
                    />
                  </div>
                </div>
              );
            }

            return (
              <div
                key={e.event.getId() ?? `${eventTs(e.event)}:${sender}`}
                className={cn("flex", isMe ? "justify-end" : "justify-start")}
              >
                <div
                  className="max-w-[85%] rounded-2xl px-3 py-2 text-[14px] leading-5 shadow-sm"
                  style={{
                    background: isMe ? "var(--bubble-me)" : "var(--bubble-other)",
                    boxShadow: "0 1px 0 rgba(0,0,0,0.08)",
                  }}
                >
                  {!isMe && sender ? (
                    <div className="mb-1 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
                      {sender}
                    </div>
                  ) : null}

                  {e.kind === "text" ? <div className="whitespace-pre-wrap">{e.body}</div> : null}

                  <div className="mt-1 text-right text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {new Date(eventTs(e.event)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>
            );
          })}

          {activeChoice ? (
            <div className="pt-2">
              <ChoiceSelectorCard
                content={activeChoice.content}
                onSubmit={(selected) => submitChoice(activeChoice.content.request_id, selected)}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t bg-white" style={{ borderColor: "var(--divider)" }}>
        <div className="mx-auto w-full max-w-3xl px-3 py-3">
          <div className="flex items-center gap-2">
            <Input
              value={message}
              disabled={composerDisabled || sendBusy}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={composerDisabled ? "Composer disabled" : `Message ${room?.name || ""}`.trim()}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!composerDisabled && !sendBusy) void sendText();
                }
              }}
              className="h-11 rounded-full bg-slate-50 px-4"
            />
            <Button
              className="h-11 rounded-full px-5"
              disabled={composerDisabled || sendBusy || message.trim().length === 0}
              onClick={() => void sendText()}
            >
              {sendBusy ? "Sending..." : "Send"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

