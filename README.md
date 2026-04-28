## Matrix choice-selector POC

Repo has 3 parts:
- `ui/`: React chat UI (Matrix client)
- `mcp/`: Python MCP server (tool provider)
- `agent/`: Python Matrix bot (Groq + tool calling + choice selector)

### Custom Matrix events
- **choice request** event type: `com.poc.choice_selector`
  - content:
    - `request_id`: string
    - `prompt`: string
    - `options`: `{ id: string, label: string }[]`
    - `allow_multiple`: boolean
    - `created_by`: `"agent"`
- **choice result** event type: `com.poc.choice_result`
  - content:
    - `request_id`: string
    - `selected_option_ids`: string[]
    - `submitted_by`: string (user mxid)

UI behavior:
- render `com.poc.choice_selector` as selector card
- disable composer while pending selector exists (until matching `com.poc.choice_result` sent)

Bot behavior:
- when waiting choice result: ignore user text messages
- only accept `com.poc.choice_result` with matching `request_id`

---

## Run MCP server

```bash
python -m venv mcp/.venv
mcp/.venv/bin/pip install -r mcp/requirements.txt

MCP_HOST=127.0.0.1 MCP_PORT=8000 mcp/.venv/bin/python mcp/server.py
```

Server listen: `http://127.0.0.1:8000/mcp`

---

## Run agent bot

Create `agent/.env`:

```bash
MATRIX_HOMESERVER_URL=http://localhost:8008
MATRIX_USER=@bot:example.org
MATRIX_PASSWORD=your_bot_password

GROQ_API_KEY=...
GROQ_MODEL=llama-3.3-70b-versatile

CONTEXT_MESSAGE_LIMIT=20
MCP_SERVER_URL=http://127.0.0.1:8000/mcp
```

Run:

```bash
python -m venv agent/.venv
agent/.venv/bin/pip install -r agent/requirements.txt

cd agent
../agent/.venv/bin/python bot.py
```

Bot auto-join invited rooms. In UI, create private room and set **Invite bot mxid**.

---

## Run UI

Optional `ui/.env`:

```bash
VITE_MATRIX_HOMESERVER_URL=http://localhost:8008
```

Run:

```bash
cd ui
npm install
npm run dev
```

Flow:
- login (password login)
- pick room or create private room (invite bot mxid)
- chat

---

## Notes / troubleshooting
- If choice card shown, composer lock active until user hits **Submit** (sends `com.poc.choice_result`).
- Bot uses last N messages for context (`CONTEXT_MESSAGE_LIMIT`).
- If bot no reply, check:
  - bot invited to room + joined
  - Groq key/model valid
  - homeserver URL correct

