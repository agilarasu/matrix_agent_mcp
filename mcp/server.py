import html
import os
import re
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP


PORT = int(os.environ.get("MCP_PORT", "8000"))
HOST = os.environ.get("MCP_HOST", "127.0.0.1")
MAX_CHARS = int(os.environ.get("FETCH_MAX_CHARS", "4000"))

mcp = FastMCP("matrix-agent-mcp", stateless_http=True, json_response=True, host=HOST, port=PORT)

LEGAL_FILES: list[dict[str, str]] = [
  {
    "id": "file-001",
    "name": "Buyer_Mineral_Rights_Lease_Agreement_2026.pdf",
    "party": "buyer",
    "owner": "buyer",
  },
  {
    "id": "file-002",
    "name": "Seller_Land_Lease_Disclosure_Mineral_Addendum.docx",
    "party": "seller",
    "owner": "seller",
  },
  {
    "id": "file-003",
    "name": "Buyer_Title_Commitment_Mineral_Exceptions.pdf",
    "party": "buyer",
    "owner": "john",
  },
  {
    "id": "file-004",
    "name": "Seller_Offer_to_Lease_Mineral_Tract_18B.pdf",
    "party": "seller",
    "owner": "john",
  },
  {
    "id": "file-005",
    "name": "Joint_Buyer_Seller_Rental_Terms_With_Mineral_Clause.pdf",
    "party": "both",
    "owner": "both",
  },
]

FILE_TASKS: dict[str, list[dict[str, str]]] = {f["id"]: [] for f in LEGAL_FILES}


def _strip_html(raw: str) -> str:
  raw = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", raw, flags=re.DOTALL | re.IGNORECASE)
  raw = re.sub(r"<[^>]+>", " ", raw)
  raw = html.unescape(raw)
  return re.sub(r"\s+", " ", raw).strip()


@mcp.tool()
async def fetch_url(url: str) -> dict[str, Any]:
  """Fetch a URL and return its text content, stripped of HTML tags.

  Args:
    url: The URL to fetch (http or https).
  """
  headers = {"User-Agent": "Mozilla/5.0 matrix-agent-mcp/1.0"}
  async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
    resp = await client.get(url, headers=headers)
    resp.raise_for_status()
    ct = resp.headers.get("content-type", "")
    raw = resp.text
    text = _strip_html(raw) if "html" in ct else raw
    truncated = len(text) > MAX_CHARS
    return {
      "url": str(resp.url),
      "status": resp.status_code,
      "content_type": ct,
      "text": text[:MAX_CHARS],
      "truncated": truncated,
      "total_chars": len(text),
    }


@mcp.tool()
async def search_files(query: str = "", owner: str | None = None) -> dict[str, Any]:
  """Search hardcoded legal document files for buyer/seller mineral rent use-cases.

  Args:
    query: Free-text phrase from the user to find matching files.
    owner: Optional owner filter (ex: buyer, seller, both).
  """
  q = (query or "").strip().lower()
  owner_q = (owner or "").strip().lower() or None

  matches = LEGAL_FILES
  if owner_q:
    matches = [f for f in matches if owner_q in f.get("owner", "").lower()]

  if q:
    def _haystack(file_obj: dict[str, str]) -> str:
      return " ".join(
        [
          file_obj.get("name", ""),
          file_obj.get("party", ""),
          file_obj.get("owner", ""),
        ]
      ).lower()

    matches = [f for f in matches if q in _haystack(f)]
  return {
    "query": query,
    "owner": owner,
    "total_matches": len(matches),
    "results": matches,
  }


@mcp.tool()
async def add_task_to_a_file(
  file_id: str,
  priority: str,
  assigned_to: str,
  note: str,
  confirmed: bool = False,
) -> dict[str, Any]:
  """Add a task to a selected legal file.

  Args:
    file_id: Selected file identifier.
    priority: Task priority (low, medium, high, urgent).
    assigned_to: Person/team to assign the task to.
    note: Task note entered by user.
    confirmed: Must be true after user confirmation.
  """
  file_obj = next((f for f in LEGAL_FILES if f["id"] == file_id), None)
  if file_obj is None:
    return {"ok": False, "error": "file_not_found", "message": f"Unknown file_id '{file_id}'."}

  if not confirmed:
    return {
      "ok": False,
      "error": "confirmation_required",
      "message": "User must confirm task creation before submit.",
    }

  missing = []
  if not (priority or "").strip():
    missing.append("priority")
  if not (assigned_to or "").strip():
    missing.append("assigned_to")
  if not (note or "").strip():
    missing.append("note")
  if missing:
    return {"ok": False, "error": "missing_fields", "missing_fields": missing}

  task = {
    "task_id": f"task-{len(FILE_TASKS[file_id]) + 1:03d}",
    "priority": priority.strip().lower(),
    "assigned_to": assigned_to.strip(),
    "note": note.strip(),
  }
  FILE_TASKS[file_id].append(task)
  return {
    "ok": True,
    "file": file_obj,
    "task": task,
    "total_tasks_for_file": len(FILE_TASKS[file_id]),
  }


def main() -> None:
  mcp.run(transport="streamable-http")


if __name__ == "__main__":
  main()
