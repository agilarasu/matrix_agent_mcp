import os
import time
from typing import Any

from mcp.server.fastmcp import FastMCP


PORT = int(os.environ.get("MCP_PORT", "8000"))
HOST = os.environ.get("MCP_HOST", "127.0.0.1")

# Stateless + JSON response good for POC + remote use
mcp = FastMCP("matrix-choice-poc", stateless_http=True, json_response=True, host=HOST, port=PORT)


@mcp.tool()
async def simulate_task(input: str) -> dict[str, Any]:
  """Simulate some task.

  Args:
    input: Any text input.
  """
  now = int(time.time())
  return {
    "summary": f"simulate_task ok: {input}",
    "ts": now,
    "meta": {"length": len(input)},
  }


def main() -> None:
  mcp.run(transport="streamable-http")


if __name__ == "__main__":
  main()

