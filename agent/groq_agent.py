import json
import os
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal

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
    self.on_tool_call: Callable[[dict[str, Any]], Awaitable[None]] | None = None

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
          "name": "search_files",
          "description": "Search legal documentation files (buyers/sellers renting land with mineral rights). Supports free-text query and optional owner filter.",
          "parameters": {
            "type": "object",
            "properties": {
              "query": {
                "type": "string",
                "description": "Natural language phrase or partial file name to find relevant files.",
              },
              "owner": {
                "type": "string",
                "description": "Optional owner filter (buyer, seller, both).",
              }
            },
          },
        },
      },
      {
        "type": "function",
        "function": {
          "name": "show_tasks",
          "description": "Show tasks for one file_id or all files.",
          "parameters": {
            "type": "object",
            "properties": {
              "file_id": {
                "type": "string",
                "description": "Optional file identifier. If omitted, return tasks for all files.",
              }
            },
          },
        },
      },
      {
        "type": "function",
        "function": {
          "name": "add_task_to_a_file",
          "description": "Stage or create a task for an existing legal file. Use confirmed=false to stage/show form; confirmed=true to create.",
          "parameters": {
            "type": "object",
            "properties": {
              "file_id": {"type": "string"},
              "priority": {"type": "string", "enum": ["low", "medium", "high", "urgent"]},
              "assigned_to": {"type": "string"},
              "note": {"type": "string"},
              "confirmed": {"type": "boolean"},
            },
            "required": ["file_id", "confirmed"],
          },
        },
      },
    ]

  def _system_prompt(self) -> str:
    return (
      "You are a chat-widget assistant for legal documentation workflows focused on buyers and sellers "
      "renting land that may contain mineral rights. "
      "Primary use-case: add_task_to_a_file.\n"
      "Rules:\n"
      "1) Before adding a task, collect and confirm all fields: priority, assigned_to, and note.\n"
      "2) Search candidate files with search_files before add_task_to_a_file.\n"
      "3) If search_files returns multiple results, call trigger_choice_selector so user selects one file_id.\n"
      "4) Only show non-file choice selectors after file_id is selected.\n"
      "5) NEVER ask the user for priority in chat text.\n"
      "6) Immediately stage a draft by calling add_task_to_a_file with confirmed=false (include known fields; leave unknown as empty).\n"
      "7) The UI form handles edits for note, assigned_to, and priority. Priority is selected only in form.\n"
      "8) When you receive a 'Task form submission:' user message, immediately call add_task_to_a_file with those exact values and confirmed=true.\n"
      "9) If user cancels, do not call add_task_to_a_file.\n"
      "10) Do not use choice selectors for priority or task confirmation.\n"
      "11) While a choice selector is shown, wait for the choice result before continuing.\n"
      "12) Keep responses short, practical, and action-oriented."
      "13) If the user asks like 'show me John's files', you should call search_files with the query 'John', and in 'Assigned to' field, you should put 'John'"
      "14) If the user asks to show tasks, call show_tasks (optionally with file_id if user specifies a file)."
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

  async def _call_mcp_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    async with streamable_http_client(self.mcp_server_url) as (read_stream, write_stream, _):
      async with ClientSession(read_stream, write_stream) as session:
        await session.initialize()
        result = await session.call_tool(tool_name, arguments=arguments)
        if result.structuredContent:
          return dict(result.structuredContent)
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
        if self.on_tool_call is not None:
          await self.on_tool_call(
            {
              "tool_call_id": tc.get("id"),
              "tool_name": name,
              "arguments": args,
              "source": "agent",
            }
          )

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

        if name == "add_task_to_a_file":
          file_id = str(args.get("file_id", "") or "").strip()
          if not file_id:
            messages.append(
              {
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": json.dumps(
                  {
                    "ok": False,
                    "error": "missing_file_id",
                    "instruction": "Search/select file first, then continue task creation flow.",
                  }
                ),
              }
            )
            continue

          confirmed = bool(args.get("confirmed", False))
          if not confirmed:
            # Stage draft UI via tool-call event, then pause assistant output
            # until user submits/cancels the task form.
            return "assistant_text", {"messages": messages, "assistant": {"content": ""}}

          note = str(args.get("note", "") or "").strip()
          assigned_to = str(args.get("assigned_to", "") or "").strip()
          priority = str(args.get("priority", "") or "").strip()
          missing = []
          if not note:
            missing.append("note")
          if not assigned_to:
            missing.append("assigned_to")
          if not priority:
            missing.append("priority")
          if missing:
            messages.append(
              {
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": json.dumps(
                  {
                    "ok": False,
                    "error": "missing_fields",
                    "missing_fields": missing,
                    "instruction": "Collect missing values in task form and resubmit confirmed=true.",
                  }
                ),
              }
            )
            continue

          out = await self._call_mcp_tool(name, args)
          messages.append(
            {
              "role": "tool",
              "tool_call_id": tc["id"],
              "content": json.dumps(out),
            }
          )
          continue

        if name == "search_files":
          out = await self._call_mcp_tool(name, args)
          messages.append(
            {
              "role": "tool",
              "tool_call_id": tc["id"],
              "content": json.dumps(out),
            }
          )
          continue

        if name == "show_tasks":
          out = await self._call_mcp_tool(name, args)
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

