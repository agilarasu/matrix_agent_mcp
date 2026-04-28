import asyncio
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
  UnknownEvent,
)

from groq_agent import GroqChatAgent, PendingChoice


CHOICE_SELECTOR_TYPE = "com.poc.choice_selector"
CHOICE_RESULT_TYPE = "com.poc.choice_result"


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

  def _hist_append_text(self, room_id: str, is_user: bool, body: str) -> None:
    self.history[room_id].append({"kind": "text", "is_user": is_user, "body": body})

  def _hist_append_choice_result(self, room_id: str, request_id: str, selected: list[str]) -> None:
    self.history[room_id].append(
      {"kind": "choice_result", "is_user": True, "request_id": request_id, "selected_option_ids": selected}
    )

  async def _send_text(self, room_id: str, body: str) -> None:
    await self.client.room_send(
      room_id,
      message_type="m.room.message",
      content={"msgtype": "m.text", "body": body},
    )
    self._hist_append_text(room_id, is_user=False, body=body)

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
    kind, payload = await self.agent.run_until_assistant_or_choice(hist)

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

  async def on_invite(self, room: MatrixRoom, event: InviteMemberEvent) -> None:
    logging.info("invite room=%s from=%s", room.room_id, getattr(event, "sender", ""))
    resp = await self.client.join(room.room_id)
    logging.info("join room=%s resp=%s", room.room_id, type(resp).__name__)

  async def on_text(self, room: MatrixRoom, event: RoomMessageText) -> None:
    try:
      if event.sender == self.client.user_id:
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

      kind, payload = await self.agent.run_from_messages_until_assistant_or_choice(messages)
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
    except Exception:
      logging.exception("on_unknown error")

  async def run(self) -> None:
    logging.info("login start user=%s homeserver=%s", self.user, self.homeserver)
    resp = await self.client.login(self.password)
    logging.info("login resp=%s user_id=%s device_id=%s", type(resp).__name__, self.client.user_id, self.client.device_id)

    self.client.add_event_callback(self.on_invite, InviteMemberEvent)
    self.client.add_event_callback(self.on_text, RoomMessageText)
    self.client.add_event_callback(self.on_unknown, UnknownEvent)

    logging.info("sync_forever start")
    await self.client.sync_forever(timeout=30_000, full_state=True)


async def main() -> None:
  load_dotenv()
  logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
  )
  bot = MatrixGroqBot()
  await bot.run()


if __name__ == "__main__":
  asyncio.run(main())

