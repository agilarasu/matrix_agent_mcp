import asyncio
import contextlib
import json
import logging
import os
from collections import defaultdict, deque
from typing import Any

from dotenv import load_dotenv
from nio import (
  AsyncClient,
  AsyncClientConfig,
  InviteMemberEvent,
  MatrixRoom,
  RoomMessageText,
  SyncResponse,
  UnknownEvent,
)

from groq_agent import GroqChatAgent, PendingChoice


CHOICE_SELECTOR_TYPE = "com.poc.choice_selector"
CHOICE_RESULT_TYPE = "com.poc.choice_result"
TOOL_CALL_TYPE = "com.poc.tool_call"


def env(name: str, default: str | None = None) -> str:
  v = os.environ.get(name, default)
  if v is None or v == "":
    raise RuntimeError(f"Missing env {name}")
  return v


class MatrixGroqBot:
  def __init__(self) -> None:
    self.homeserver = env("MATRIX_HOMESERVER_URL")
    self.user = env("MATRIX_USER")
    self.password = env("MATRIX_PASSWORD")
    self.context_limit = int(os.environ.get("CONTEXT_MESSAGE_LIMIT", "20"))

    req_timeout = float(os.environ.get("MATRIX_REQUEST_TIMEOUT", "60"))
    max_timeouts = os.environ.get("MATRIX_MAX_TIMEOUTS")
    cfg = AsyncClientConfig(
      request_timeout=req_timeout,
      max_timeouts=None if not max_timeouts else int(max_timeouts),
    )
    self.client = AsyncClient(self.homeserver, self.user, config=cfg)
    self.agent = GroqChatAgent()

    self.history: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=200))
    self.pending: dict[str, PendingChoice] = {}
    self.seen_event_ids: deque[str] = deque(maxlen=4000)
    self.seen_event_ids_set: set[str] = set()
    self.sync_token: str | None = None
    self.state_file = os.environ.get("BOT_STATE_FILE", "state.json")
    self._load_state()
    self.agent.on_tool_call = self._on_agent_tool_call

  def _load_state(self) -> None:
    if not os.path.exists(self.state_file):
      return
    try:
      with open(self.state_file, "r", encoding="utf-8") as f:
        data = json.load(f)
      if not isinstance(data, dict):
        return

      raw_history = data.get("history", {})
      if isinstance(raw_history, dict):
        self.history = defaultdict(lambda: deque(maxlen=200))
        for room_id, items in raw_history.items():
          if isinstance(room_id, str) and isinstance(items, list):
            clean = [x for x in items if isinstance(x, dict)]
            self.history[room_id] = deque(clean, maxlen=200)

      raw_pending = data.get("pending", {})
      if isinstance(raw_pending, dict):
        self.pending = {}
        for room_id, item in raw_pending.items():
          if not isinstance(room_id, str) or not isinstance(item, dict):
            continue
          request_id = item.get("request_id")
          tool_call_id = item.get("tool_call_id")
          messages = item.get("messages")
          if isinstance(request_id, str) and isinstance(tool_call_id, str) and isinstance(messages, list):
            self.pending[room_id] = PendingChoice(
              request_id=request_id,
              tool_call_id=tool_call_id,
              messages=[m for m in messages if isinstance(m, dict)],
            )

      raw_seen = data.get("seen_event_ids", [])
      if isinstance(raw_seen, list):
        ids = [x for x in raw_seen if isinstance(x, str)]
        self.seen_event_ids = deque(ids, maxlen=4000)
        self.seen_event_ids_set = set(self.seen_event_ids)

      token = data.get("sync_token")
      if isinstance(token, str) and token:
        self.sync_token = token
    except Exception:
      logging.exception("failed to load bot state")

  def _save_state(self) -> None:
    try:
      state = {
        "history": {room_id: list(items) for room_id, items in self.history.items()},
        "pending": {
          room_id: {
            "request_id": p.request_id,
            "tool_call_id": p.tool_call_id,
            "messages": p.messages,
          }
          for room_id, p in self.pending.items()
        },
        "seen_event_ids": list(self.seen_event_ids),
        "sync_token": self.sync_token,
      }
      with open(self.state_file, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=True)
    except Exception:
      logging.exception("failed to save bot state")

  def _mark_event_seen(self, event: Any) -> bool:
    event_id = getattr(event, "event_id", None)
    if not isinstance(event_id, str) or not event_id:
      return True
    if event_id in self.seen_event_ids_set:
      return False
    self.seen_event_ids.append(event_id)
    self.seen_event_ids_set.add(event_id)
    while len(self.seen_event_ids_set) > self.seen_event_ids.maxlen:
      old = self.seen_event_ids.popleft()
      self.seen_event_ids_set.discard(old)
    self._save_state()
    return True

  def _hist_append_text(self, room_id: str, is_user: bool, body: str) -> None:
    self.history[room_id].append({"kind": "text", "is_user": is_user, "body": body})
    self._save_state()

  def _hist_append_choice_result(self, room_id: str, request_id: str, selected: list[str]) -> None:
    self.history[room_id].append(
      {"kind": "choice_result", "is_user": True, "request_id": request_id, "selected_option_ids": selected}
    )
    self._save_state()

  async def _send_text(self, room_id: str, body: str) -> None:
    await self.client.room_send(
      room_id,
      message_type="m.room.message",
      content={"msgtype": "m.text", "body": body},
    )
    self._hist_append_text(room_id, is_user=False, body=body)

  async def _set_typing(self, room_id: str, enabled: bool) -> None:
    try:
      await self.client.room_typing(room_id, typing_state=enabled, timeout=20_000)
    except Exception:
      logging.debug("typing update failed room=%s enabled=%s", room_id, enabled, exc_info=True)

  async def _on_agent_tool_call(self, payload: dict[str, Any]) -> None:
    room_id = payload.get("room_id")
    if not isinstance(room_id, str) or not room_id:
      return
    content = {
      "tool_call_id": payload.get("tool_call_id"),
      "tool_name": payload.get("tool_name"),
      "arguments": payload.get("arguments"),
      "source": "agent",
    }
    await self.client.room_send(
      room_id,
      message_type=TOOL_CALL_TYPE,
      content=content,
    )

  async def _send_choice_selector(
    self,
    room_id: str,
    request_id: str,
    prompt: str,
    options: list[dict[str, str]],
    allow_multiple: bool,
  ) -> None:
    await self.client.room_send(
      room_id,
      message_type=CHOICE_SELECTOR_TYPE,
      content={
        "request_id": request_id,
        "prompt": prompt,
        "options": options,
        "allow_multiple": allow_multiple,
        "created_by": "agent",
      },
    )

  async def _respond_if_needed(self, room_id: str) -> None:
    if room_id in self.pending:
      return

    hist = list(self.history[room_id])[-self.context_limit :]
    prev_tool_cb = self.agent.on_tool_call
    self.agent.on_tool_call = lambda payload: self._on_agent_tool_call({**payload, "room_id": room_id})
    await self._set_typing(room_id, True)
    try:
      kind, payload = await self.agent.run_until_assistant_or_choice(hist)
    finally:
      await self._set_typing(room_id, False)
      self.agent.on_tool_call = prev_tool_cb

    if kind == "assistant_text":
      assistant = payload["assistant"]
      text = (assistant.get("content") or "").strip()
      if text:
        await self._send_text(room_id, text)
      return

    # choice requested
    request_id = payload["request_id"]
    await self._send_choice_selector(
      room_id,
      request_id=request_id,
      prompt=payload["prompt"],
      options=payload["options"],
      allow_multiple=payload["allow_multiple"],
    )
    self.pending[room_id] = PendingChoice(
      request_id=request_id,
      tool_call_id=payload["tool_call_id"],
      messages=payload["messages"],
    )
    self._save_state()

  async def on_invite(self, room: MatrixRoom, event: InviteMemberEvent) -> None:
    logging.info("invite room=%s from=%s", room.room_id, getattr(event, "sender", ""))
    resp = await self.client.join(room.room_id)
    logging.info("join room=%s resp=%s", room.room_id, type(resp).__name__)

  async def on_text(self, room: MatrixRoom, event: RoomMessageText) -> None:
    try:
      if event.sender == self.client.user_id:
        return
      if not self._mark_event_seen(event):
        return
      if room.room_id in self.pending:
        logging.info("ignore text (pending choice) room=%s sender=%s body=%r", room.room_id, event.sender, event.body)
        return

      logging.info("text room=%s sender=%s body=%r", room.room_id, event.sender, event.body)

      self._hist_append_text(room.room_id, is_user=True, body=event.body)
      await self._respond_if_needed(room.room_id)
    except Exception:
      logging.exception("on_text error")

  async def on_unknown(self, room: MatrixRoom, event: UnknownEvent) -> None:
    try:
      et = getattr(event, "type", None)
      if et != CHOICE_RESULT_TYPE:
        if os.environ.get("DEBUG_EVENTS") == "1":
          logging.info("unknown event room=%s type=%s", room.room_id, et)
        return
      if not self._mark_event_seen(event):
        return

      content = event.source.get("content") if isinstance(event.source, dict) else None
      if not isinstance(content, dict):
        return

      request_id = content.get("request_id")
      selected = content.get("selected_option_ids")
      submitted_by = content.get("submitted_by")
      if not isinstance(request_id, str) or not isinstance(selected, list) or not isinstance(submitted_by, str):
        return

      logging.info(
        "choice_result room=%s request_id=%s submitted_by=%s selected=%s",
        room.room_id,
        request_id,
        submitted_by,
        selected,
      )

      # record user choice
      try:
        selected_ids = [str(x) for x in selected]
      except Exception:
        return
      self._hist_append_choice_result(room.room_id, request_id=request_id, selected=selected_ids)

      pending = self.pending.get(room.room_id)
      if not pending or pending.request_id != request_id:
        return

      # resume LLM with tool result
      tool_result = {"request_id": request_id, "selected_option_ids": selected_ids, "submitted_by": submitted_by}
      messages = list(pending.messages)
      messages.append(
        {
          "role": "tool",
          "tool_call_id": pending.tool_call_id,
          "content": json.dumps(tool_result),
        }
      )

      # clear pending before calling model (avoid deadlock if model asks new choice)
      self.pending.pop(room.room_id, None)
      self._save_state()

      prev_tool_cb = self.agent.on_tool_call
      self.agent.on_tool_call = lambda payload: self._on_agent_tool_call({**payload, "room_id": room.room_id})
      await self._set_typing(room.room_id, True)
      try:
        kind, payload = await self.agent.run_from_messages_until_assistant_or_choice(messages)
      finally:
        await self._set_typing(room.room_id, False)
        self.agent.on_tool_call = prev_tool_cb
      if kind == "assistant_text":
        msg = payload["assistant"]
        text = (msg.get("content") or "").strip()
        if text:
          await self._send_text(room.room_id, text)
        return

      # model asked another choice immediately
      request_id2 = payload["request_id"]
      await self._send_choice_selector(
        room.room_id,
        request_id=request_id2,
        prompt=payload["prompt"],
        options=payload["options"],
        allow_multiple=payload["allow_multiple"],
      )
      self.pending[room.room_id] = PendingChoice(
        request_id=request_id2,
        tool_call_id=payload["tool_call_id"],
        messages=payload["messages"],
      )
      self._save_state()
    except Exception:
      logging.exception("on_unknown error")

  async def run(self) -> None:
    logging.info("login start user=%s homeserver=%s", self.user, self.homeserver)
    resp = await self.client.login(self.password)
    logging.info("login resp=%s user_id=%s device_id=%s", type(resp).__name__, self.client.user_id, self.client.device_id)

    if not self.sync_token:
      # First bootstrapping sync: establish a baseline token without processing older room timeline.
      bootstrap = await self.client.sync(timeout=0, full_state=False)
      if isinstance(bootstrap, SyncResponse):
        self.sync_token = bootstrap.next_batch
        self._save_state()
      logging.info("sync bootstrap token initialized=%s", bool(self.sync_token))

    self.client.add_event_callback(self.on_invite, InviteMemberEvent)
    self.client.add_event_callback(self.on_text, RoomMessageText)
    self.client.add_event_callback(self.on_unknown, UnknownEvent)

    logging.info("sync loop start")
    while True:
      try:
        sync_resp = await self.client.sync(timeout=30_000, since=self.sync_token, full_state=False)
        if isinstance(sync_resp, SyncResponse):
          self.sync_token = sync_resp.next_batch
          self._save_state()
      except asyncio.CancelledError:
        raise
      except Exception:
        logging.exception("sync loop error")
        await asyncio.sleep(2)


async def main() -> None:
  load_dotenv()
  logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
  )
  bot = MatrixGroqBot()
  await bot.run()


if __name__ == "__main__":
  with contextlib.suppress(KeyboardInterrupt):
    asyncio.run(main())

