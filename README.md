# email-mcp

MCP server that turns the existing `email_bridge.py` workflow into tool-level primitives with automatic single-thread mapping.

## Tools

- `email_update`
  - Sends a progress update in the mapped Gmail thread.
- `email_ask`
  - Sends a question in the mapped Gmail thread, then blocks until a reply arrives (or timeout).
- `email_fetch_response`
  - Non-blocking fetch of new replies from the same mapped thread.

## Automatic Thread Mapping

Mapping key selection order:

1. explicit `context_id` argument
2. `CODEX_THREAD_ID` env var
3. `CODEX_SESSION_ID` env var
4. fallback: process-scoped key (`proc-<pid>-<random>`)

Behavior:

- One mapping key -> one Gmail thread.
- Mapping is stored in `~/.codex/email-bridge/mcp-state/thread-map.json`.
- For non-Codex clients, pass `context_id` in tool calls if you want separate Gmail threads per chat/session.
- Optional override: set `EMAIL_MCP_PROCESS_SESSION_KEY` to force a fixed fallback key.

## Prerequisites

This server includes a local bridge script at `bridge/email_bridge.py` (used as fallback when direct SMTP mode is unavailable).

Configure the same mailbox env vars used by that script:

- `CODEX_EMAIL_ADDRESS`
- `CODEX_EMAIL_PASSWORD`
- `CODEX_EMAIL_TO` (or pass `to` in tool calls)
- optional SMTP/IMAP host/port vars from the email-bridge docs

## Install

```bash
cd email-mcp
npm install
```

## Add To Your App (MCP)

This is a local `stdio` MCP server.

- command: `node`
- args: `["/absolute/path/to/email-mcp/index.js"]`
- env: mailbox credentials + optional tuning flags

Recommended env vars:

- `CODEX_EMAIL_ADDRESS`
- `CODEX_EMAIL_PASSWORD`
- `CODEX_EMAIL_TO`
- `EMAIL_MCP_PREWARM=true`
- `EMAIL_MCP_BRIDGE_SCRIPT=/absolute/path/to/email-mcp/bridge/email_bridge.py`
- `EMAIL_MCP_PYTHON=python3`

### Codex (`~/.codex/config.toml`)

Add this in `~/.codex/config.toml`:

```toml
[mcp_servers.email]
command = "node"
args = ["/absolute/path/to/email-mcp/index.js"]
tool_timeout_sec = 3600

[mcp_servers.email.env]
CODEX_EMAIL_ADDRESS = "your_email@gmail.com"
CODEX_EMAIL_PASSWORD = "your_app_password"
CODEX_EMAIL_TO = "recipient@example.com"
EMAIL_MCP_PREWARM = "true"
EMAIL_MCP_BRIDGE_SCRIPT = "/absolute/path/to/email-mcp/bridge/email_bridge.py"
EMAIL_MCP_PYTHON = "python3"
```

`tool_timeout_sec` is important for `email_ask`, since it can wait for a long time.

### Cursor (`~/.cursor/mcp.json` or project `.cursor/mcp.json`)

Add:

```json
{
  "mcpServers": {
    "email-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/email-mcp/index.js"],
      "env": {
        "CODEX_EMAIL_ADDRESS": "your_email@gmail.com",
        "CODEX_EMAIL_PASSWORD": "your_app_password",
        "CODEX_EMAIL_TO": "recipient@example.com",
        "EMAIL_MCP_PREWARM": "true"
      }
    }
  }
}
```

Then restart Cursor.

### Claude Code

Use MCP add with stdio:

```bash
claude mcp add --transport stdio \
  --env CODEX_EMAIL_ADDRESS=your_email@gmail.com \
  --env CODEX_EMAIL_PASSWORD=your_app_password \
  --env CODEX_EMAIL_TO=recipient@example.com \
  --env EMAIL_MCP_PREWARM=true \
  email-mcp -- node /absolute/path/to/email-mcp/index.js
```

If your Claude client uses JSON `mcpServers` config instead, use the same block shown in the Cursor example.

## Notes

- `email_ask` flushes already-seen replies before sending the new question, so it waits for a fresh reply.
- `email_fetch_response` defaults to `advance=true`, meaning fetched replies will not appear again on later fetches.
- For stable Gmail threading, each mapped session uses one canonical subject base; later `subject` inputs are ignored for that session.
- `email_ask` and `email_fetch_response` keep a persistent IMAP session (auto-IDLE), so reply detection is much faster after warm-up.
- `email_update`/`email_ask` use a pooled SMTP transport when SMTP env vars are present, which reduces repeated send overhead.
- Default `email_ask` polling interval is 5 seconds (override with `poll_seconds`).
- Startup prewarm is enabled by default (`EMAIL_MCP_PREWARM=true`) and begins IMAP/SMTP warm-up as soon as the MCP server starts.
