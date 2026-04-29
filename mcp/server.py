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


def main() -> None:
  mcp.run(transport="streamable-http")


if __name__ == "__main__":
  main()
