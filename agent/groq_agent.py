import json
import os
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from groq import Groq
from mcp import ClientSession, types
from mcp.client.streamable_http import streamable_http_client


Role = Literal["system", "user", "assistant", "tool"]


@dataclass
class PendingChoice:
  request_id: str
  tool_call_id: str
  messages: list[dict[str, Any]]


class GroqChatAgent:
  def __init__(self) -> None:
    self.groq = Groq(api_key=os.environ["GROQ_API_KEY"])
    self.model = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
    self.context_limit = int(os.environ.get("CONTEXT_MESSAGE_LIMIT", "20"))
    self.mcp_server_url = os.environ.get("MCP_SERVER_URL", "http://127.0.0.1:8000/mcp").rstrip("/")

  def _tool_defs(self) -> list[dict[str, Any]]:
    return [
      {
        "type": "function",
        "function": {
          "name": "trigger_choice_selector",
          "description": "Ask user to pick option(s). UI will render selector and lock composer until result submitted.",
          "parameters": {
            "type": "object",
            "properties": {
              "prompt": {"type": "string"},
              "options": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {"id": {"type": "string"}, "label": {"type": "string"}},
                  "required": ["id", "label"],
                },
              },
              "allow_multiple": {"type": "boolean", "default": False},
            },
            "required": ["prompt", "options"],
          },
        },
      },
      {
        "type": "function",
        "function": {
          "name": "simulate_task",
          "description": "Call MCP demo tool simulate_task(input) and return its JSON output.",
          "parameters": {
            "type": "object",
            "properties": {"input": {"type": "string"}},
            "required": ["input"],
          },
        },
      },
    ]

  def _system_prompt(self) -> str:
    return (
      "You are AI assistant in Matrix room. "
      "If you need user choice, call trigger_choice_selector with clear prompt and options. "
      "When choice selector shown, user cannot type; do not ask for typed input until choice result comes back. "
      "Keep replies short."
    )

  def build_messages(self, room_history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    msgs: list[dict[str, Any]] = [{"role": "system", "content": self._system_prompt()}]
    for item in room_history[-self.context_limit :]:
      if item["kind"] == "text":
        msgs.append({"role": "user" if item["is_user"] else "assistant", "content": item["body"]})
      elif item["kind"] == "choice_result":
        msgs.append(
          {
            "role": "user",
            "content": f"Choice submitted: {', '.join(item['selected_option_ids'])} (request_id={item['request_id']})",
          }
        )
    return msgs

  async def _call_mcp_simulate_task(self, input_text: str) -> dict[str, Any]:
    async with streamable_http_client(self.mcp_server_url) as (read_stream, write_stream, _):
      async with ClientSession(read_stream, write_stream) as session:
        await session.initialize()
        result = await session.call_tool("simulate_task", arguments={"input": input_text})
        if result.structuredContent:
          return dict(result.structuredContent)
        # fallback to text content
        blocks = []
        for c in result.content:
          if isinstance(c, types.TextContent):
            blocks.append(c.text)
        return {"text": "\n".join(blocks)}

  async def step(
    self,
    messages: list[dict[str, Any]],
  ) -> dict[str, Any]:
    resp = self.groq.chat.completions.create(
      model=self.model,
      messages=messages,
      tools=self._tool_defs(),
      tool_choice="auto",
    )
    return resp.to_dict()

  async def run_until_assistant_or_choice(
    self,
    room_history: list[dict[str, Any]],
  ) -> tuple[
    Literal["assistant_text", "choice_requested"],
    dict[str, Any],
  ]:
    messages = self.build_messages(room_history)
    return await self.run_from_messages_until_assistant_or_choice(messages)

  async def run_from_messages_until_assistant_or_choice(
    self,
    messages: list[dict[str, Any]],
  ) -> tuple[
    Literal["assistant_text", "choice_requested"],
    dict[str, Any],
  ]:
    while True:
      data = await self.step(messages)
      msg = data["choices"][0]["message"]
      tool_calls = msg.get("tool_calls") or []
      if not tool_calls:
        return "assistant_text", {"messages": messages, "assistant": msg}

      messages.append(
        {
          "role": "assistant",
          "content": msg.get("content") or "",
          "tool_calls": tool_calls,
        }
      )

      for tc in tool_calls:
        name = tc["function"]["name"]
        args = json.loads(tc["function"]["arguments"] or "{}")

        if name == "trigger_choice_selector":
          request_id = str(uuid.uuid4())
          return "choice_requested", {
            "request_id": request_id,
            "tool_call_id": tc["id"],
            "prompt": args["prompt"],
            "options": args["options"],
            "allow_multiple": bool(args.get("allow_multiple", False)),
            "messages": messages,
          }

        if name == "simulate_task":
          out = await self._call_mcp_simulate_task(args["input"])
          messages.append(
            {
              "role": "tool",
              "tool_call_id": tc["id"],
              "content": json.dumps(out),
            }
          )
          continue

        messages.append(
          {
            "role": "tool",
            "tool_call_id": tc["id"],
            "content": json.dumps({"error": f"unknown tool {name}"}),
          }
        )

