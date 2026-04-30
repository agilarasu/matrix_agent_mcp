import React from "react";
import type { MatrixEvent } from "matrix-js-sdk";
import { RoomEvent } from "matrix-js-sdk/lib/models/room";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useParams } from "react-router-dom";

import { ChoiceSelectorCard } from "@/components/ChoiceSelectorCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useMatrix } from "@/lib/matrix/MatrixProvider";
import {
  MATRIX_EVENT_CHOICE_RESULT,
  MATRIX_EVENT_CHOICE_SELECTOR,
  MATRIX_EVENT_TASK_FORM_SUBMIT,
  MATRIX_EVENT_TOOL_CALL,
  type ChoiceResultEventContent,
  type ChoiceSelectorEventContent,
  type TaskFormSubmitEventContent,
  type ToolCallEventContent,
} from "@/lib/matrix/types";
import { cn } from "@/lib/utils";

type RenderableEvent =
  | { kind: "text"; event: MatrixEvent; body: string }
  | { kind: "choice_selector"; event: MatrixEvent; content: ChoiceSelectorEventContent }
  | { kind: "choice_result"; event: MatrixEvent; content: ChoiceResultEventContent }
  | { kind: "task_form_submit"; event: MatrixEvent; content: TaskFormSubmitEventContent }
  | { kind: "tool_call"; event: MatrixEvent; content: ToolCallEventContent };

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
  if (type === MATRIX_EVENT_TASK_FORM_SUBMIT) {
    const c = ev.getContent() as TaskFormSubmitEventContent;
    if (
      !c?.file_id ||
      typeof c?.priority !== "string" ||
      typeof c?.assigned_to !== "string" ||
      typeof c?.note !== "string" ||
      typeof c?.confirmed !== "boolean" ||
      typeof c?.cancelled !== "boolean" ||
      !c?.submitted_by
    ) {
      return null;
    }
    return { kind: "task_form_submit", event: ev, content: c };
  }
  if (type === MATRIX_EVENT_TOOL_CALL) {
    const c = ev.getContent() as ToolCallEventContent;
    if (!c || typeof c !== "object") return null;
    return { kind: "tool_call", event: ev, content: c };
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
  const [typingTick, setTypingTick] = React.useState(0);
  const [roomTick, setRoomTick] = React.useState(0);
  const [taskFormBusy, setTaskFormBusy] = React.useState(false);
  const [taskFormFileId, setTaskFormFileId] = React.useState("");
  const [taskFormPriority, setTaskFormPriority] = React.useState("");
  const [taskFormAssignedTo, setTaskFormAssignedTo] = React.useState("");
  const [taskFormNote, setTaskFormNote] = React.useState("");
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

  React.useEffect(() => {
    if (!client || !roomId) return;
    const onTyping = (_event: unknown, member: any) => {
      if (member?.roomId !== roomId) return;
      setTypingTick((t) => t + 1);
    };
    client.on("RoomMember.typing" as any, onTyping as any);
    return () => {
      client.off("RoomMember.typing" as any, onTyping as any);
    };
  }, [client, roomId]);

  const renderable = React.useMemo(() => {
    const list = events.map(toRenderable).filter(Boolean) as RenderableEvent[];
    return list.sort((a, b) => eventTs(a.event) - eventTs(b.event));
  }, [events]);

  const pendingRequestId = React.useMemo(
    () => derivePendingChoice(renderable, session?.userId),
    [renderable, session?.userId]
  );

  const room = client && roomId ? client.getRoom(roomId) : null;
  const typingUsers = React.useMemo(() => {
    if (!room || !session?.userId) return [];
    const users = ((room as any).getTypingUsers?.() ?? []) as Array<{ userId?: string }>;
    return users.map((u) => u?.userId).filter((id): id is string => Boolean(id) && id !== session.userId);
  }, [room, session?.userId, typingTick]);
  const typingText = React.useMemo(() => {
    if (typingUsers.length === 0) return "";
    if (typingUsers.length === 1) return `${typingUsers[0]} is typing...`;
    if (typingUsers.length === 2) return `${typingUsers[0]} and ${typingUsers[1]} are typing...`;
    return `${typingUsers[0]} and ${typingUsers.length - 1} others are typing...`;
  }, [typingUsers]);

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

  async function submitTaskForm(cancelled: boolean) {
    if (!client || !roomId || !session?.userId) return;
    if (!cancelled && !taskFormPriority.trim()) return;
    const content: TaskFormSubmitEventContent = {
      file_id: taskFormFileId.trim(),
      priority: taskFormPriority.trim().toLowerCase(),
      assigned_to: taskFormAssignedTo.trim(),
      note: taskFormNote.trim(),
      confirmed: !cancelled,
      cancelled,
      submitted_by: session.userId,
    };
    setTaskFormBusy(true);
    try {
      await client.sendEvent(roomId, MATRIX_EVENT_TASK_FORM_SUBMIT as any, content as any);
    } finally {
      setTaskFormBusy(false);
    }
  }

  const activeChoice = React.useMemo(() => {
    const latest = [...renderable]
      .filter((e) => e.kind === "choice_selector")
      .slice(-1)[0] as Extract<RenderableEvent, { kind: "choice_selector" }> | undefined;
    if (!latest) return null;
    if (pendingRequestId && latest.content.request_id === pendingRequestId) return latest;
    return null;
  }, [renderable, pendingRequestId]);

  const activeTaskDraft = React.useMemo(() => {
    const latest = [...renderable]
      .filter((e) => e.kind === "tool_call" && e.content.tool_name === "add_task_to_a_file")
      .slice(-1)[0] as Extract<RenderableEvent, { kind: "tool_call" }> | undefined;
    if (!latest) return null;
    const confirmed = Boolean(latest.content.arguments?.confirmed);
    if (confirmed) return null;
    const latestSubmit = [...renderable]
      .filter((e) => e.kind === "task_form_submit")
      .slice(-1)[0] as Extract<RenderableEvent, { kind: "task_form_submit" }> | undefined;
    if (latestSubmit && eventTs(latestSubmit.event) >= eventTs(latest.event)) return null;
    return latest;
  }, [renderable]);

  const composerDisabled =
    clientState !== "ready" || !client || !roomId || Boolean(pendingRequestId) || Boolean(activeTaskDraft);

  const draftOutcomeByEventId = React.useMemo(() => {
    const map = new Map<string, { cancelled: boolean; submitted_by: string }>();
    let lastDraftId: string | null = null;
    for (const e of renderable) {
      if (e.kind === "tool_call" && e.content.tool_name === "add_task_to_a_file") {
        const confirmed = Boolean(e.content.arguments?.confirmed);
        if (!confirmed) {
          lastDraftId = e.event.getId?.() ?? `${eventTs(e.event)}:${eventSender(e.event)}`;
        }
        continue;
      }
      if (e.kind === "task_form_submit" && lastDraftId) {
        map.set(lastDraftId, { cancelled: e.content.cancelled, submitted_by: e.content.submitted_by });
        lastDraftId = null;
      }
    }
    return map;
  }, [renderable]);

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
    if (!activeTaskDraft) return;
    const args = activeTaskDraft.content.arguments ?? {};
    setTaskFormFileId(typeof args.file_id === "string" ? args.file_id : "");
    setTaskFormPriority(typeof args.priority === "string" ? args.priority : "");
    setTaskFormAssignedTo(typeof args.assigned_to === "string" ? args.assigned_to : "");
    setTaskFormNote(typeof args.note === "string" ? args.note : "");
  }, [activeTaskDraft?.event.getId()]);

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
            if (e.kind === "task_form_submit") {
              return null;
            }

            if (e.kind === "tool_call") {
              const toolName = e.content.tool_name || "tool";
              const argsText = e.content.arguments ? JSON.stringify(e.content.arguments) : "";
              if (toolName === "trigger_choice_selector") return null;

              if (toolName === "search_files") {
                const query =
                  typeof e.content.arguments?.query === "string" ? e.content.arguments.query.trim() : "";
                const owner =
                  typeof e.content.arguments?.owner === "string" ? e.content.arguments.owner.trim() : "";
                return (
                  <div
                    key={e.event.getId() ?? `${eventTs(e.event)}:${sender}`}
                    className="w-full max-w-[85%] rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <div className="mb-1 font-medium text-slate-600">Searching legal files</div>
                    <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700">
                      {query ? (
                        <>
                          Query: <span className="font-medium">{query}</span>
                        </>
                      ) : (
                        "Query: (empty)"
                      )}
                      {owner ? (
                        <div className="mt-1 text-xs text-slate-600">
                          Owner: <span className="font-medium">{owner}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              }

              if (toolName === "show_tasks") {
                const fileId =
                  typeof e.content.arguments?.file_id === "string" ? e.content.arguments.file_id.trim() : "";
                return (
                  <div
                    key={e.event.getId() ?? `${eventTs(e.event)}:${sender}`}
                    className="w-full max-w-[85%] rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <div className="mb-1 font-medium text-slate-600">Fetching tasks</div>
                    <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700">
                      {fileId ? (
                        <>
                          File: <span className="font-mono font-medium">{fileId}</span>
                        </>
                      ) : (
                        "File: (all files)"
                      )}
                    </div>
                  </div>
                );
              }

              if (toolName === "add_task_to_a_file") {
                const eventId = e.event.getId() ?? `${eventTs(e.event)}:${sender}`;
                const fileId =
                  typeof e.content.arguments?.file_id === "string" ? e.content.arguments.file_id : "";
                const priority =
                  typeof e.content.arguments?.priority === "string" ? e.content.arguments.priority : "";
                const assignedTo =
                  typeof e.content.arguments?.assigned_to === "string"
                    ? e.content.arguments.assigned_to
                    : "";
                const note = typeof e.content.arguments?.note === "string" ? e.content.arguments.note : "";
                const confirmed = Boolean(e.content.arguments?.confirmed);
                const activeDraftId = activeTaskDraft
                  ? activeTaskDraft.event.getId() ??
                    `${eventTs(activeTaskDraft.event)}:${eventSender(activeTaskDraft.event)}`
                  : "";
                const isActiveDraft = !confirmed && activeDraftId === eventId;
                const draftOutcome = !confirmed ? draftOutcomeByEventId.get(eventId) ?? null : null;
                const isReadOnlyDraft = !confirmed && !isActiveDraft && Boolean(draftOutcome);

                if (!confirmed && isActiveDraft) {
                  return (
                    <div
                      key={eventId}
                      className="w-full max-w-[85%] rounded-xl border border-slate-200 bg-white p-3 text-xs"
                    >
                      <div className="mb-2 text-xs font-medium text-slate-700">Task details</div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input value={taskFormFileId} disabled className="font-mono text-xs" />
                        <select
                          value={taskFormPriority}
                          onChange={(ev) => setTaskFormPriority(ev.target.value)}
                          className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-10 rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-[3px]"
                          disabled={taskFormBusy}
                        >
                          <option value="">Select priority</option>
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="urgent">Urgent</option>
                        </select>
                      </div>
                      <div className="mt-2 space-y-2">
                        <Input
                          value={taskFormAssignedTo}
                          onChange={(ev) => setTaskFormAssignedTo(ev.target.value)}
                          placeholder="Assigned to"
                          disabled={taskFormBusy}
                        />
                        <Textarea
                          value={taskFormNote}
                          onChange={(ev) => setTaskFormNote(ev.target.value)}
                          placeholder="Task note"
                          rows={3}
                          disabled={taskFormBusy}
                        />
                      </div>
                      <div className="mt-3 flex items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          onClick={() => void submitTaskForm(true)}
                          disabled={taskFormBusy}
                        >
                          Cancel
                        </Button>
                        <Button
                          onClick={() => void submitTaskForm(false)}
                          disabled={taskFormBusy || taskFormPriority.trim().length === 0}
                        >
                          {taskFormBusy ? "Submitting..." : "Confirm Create"}
                        </Button>
                      </div>
                    </div>
                  );
                }

                if (!confirmed && isReadOnlyDraft) {
                  const statusText = draftOutcome?.cancelled ? "Cancelled" : "Submitted";
                  return (
                    <div
                      key={eventId}
                      className="w-full max-w-[85%] rounded-xl border border-slate-200 bg-white p-3 text-xs opacity-60"
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-xs font-medium text-slate-700">Task details</div>
                        <div className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                          {statusText}
                        </div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input value={fileId} disabled className="font-mono text-xs" />
                        <Input value={priority} disabled className="text-xs" placeholder="priority" />
                      </div>
                      <Input value={assignedTo} disabled className="mt-2 text-xs" placeholder="assigned to" />
                      <Textarea value={note} disabled className="mt-2 text-xs" rows={3} />
                    </div>
                  );
                }

                if (!confirmed) {
                  // Draft without outcome yet (should be active). Keep visible but disabled defensively.
                  return (
                    <div
                      key={eventId}
                      className="w-full max-w-[85%] rounded-xl border border-slate-200 bg-white p-3 text-xs opacity-60"
                    >
                      <div className="mb-2 text-xs font-medium text-slate-700">Task details</div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input value={fileId} disabled className="font-mono text-xs" />
                        <Input value={priority} disabled className="text-xs" placeholder="priority" />
                      </div>
                      <Input value={assignedTo} disabled className="mt-2 text-xs" placeholder="assigned to" />
                      <Textarea value={note} disabled className="mt-2 text-xs" rows={3} />
                    </div>
                  );
                }

                return (
                  <div
                    key={eventId}
                    className={cn(
                      "w-full max-w-[85%] rounded-xl border p-3 text-xs",
                      confirmed
                        ? "border-emerald-300 bg-emerald-50"
                        : "border-amber-300 bg-amber-50"
                    )}
                    style={{ color: "var(--text-muted)" }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium text-emerald-800">Task created</div>
                      <div className="rounded-full border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        Saved
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-emerald-800">
                      {assignedTo ? `Assigned to ${assignedTo}` : "Assigned"}
                      {priority ? ` • Priority ${priority}` : ""}
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={e.event.getId() ?? `${eventTs(e.event)}:${sender}`}
                  className="max-w-[85%] rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  <div className="font-medium text-slate-600">Tool call: {toolName}</div>
                  {argsText ? <div className="mt-1 break-all">{argsText}</div> : null}
                </div>
              );
            }

            if (e.kind === "choice_selector") {
              // render active selector as special card below; older ones stay as normal bubble
              if (pendingRequestId && e.content.request_id === pendingRequestId) return null;
            }

            if (e.kind === "choice_selector") {
              const submitted = myChoiceResultsByRequestId.get(e.content.request_id) ?? null;
              return (
                <div key={e.event.getId() ?? `${eventTs(e.event)}:${sender}`} className="flex justify-start">
                  <div className="w-full max-w-[85%]">
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

                  {e.kind === "text" ? (
                    <div className="prose prose-sm max-w-none prose-p:my-1 prose-pre:my-1 prose-code:before:content-none prose-code:after:content-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{e.body}</ReactMarkdown>
                    </div>
                  ) : null}

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
          {typingText ? (
            <div className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
              {typingText}
            </div>
          ) : null}
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

