# TrafficPeak Agent

A standalone analytics UI and Claude-powered chat assistant for [Akamai TrafficPeak](https://techdocs.akamai.com/trafficpeak/docs/mcp-server) — a ClickHouse-based analytics platform for Akamai edge delivery data.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 Browser (port 3001)                      │
│  ┌───────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Explorer  │  │     Chat     │  │      Tips        │  │
│  │ SQL query │  │ Claude-AI    │  │ Query reference  │  │
│  │ + charts  │  │ NL → SQL     │  │ + cheat sheet   │  │
│  └─────┬─────┘  └──────┬───────┘  └──────────────────┘  │
└────────┼───────────────┼──────────────────────────────── ┘
         │               │
      server.js (Express)
         │               │
    TrafficPeak       Anthropic API
    ClickHouse API    (Claude chat)
         │
  src/tools/trafficpeak.js
  (tp_list_databases, tp_list_tables,
   tp_get_schema, tp_query)
```

---

## Features

- **Explorer** — database and table browser, SQL query runner with auto-generated bar/line charts
- **Chat** — Claude-powered assistant that discovers schema and writes ClickHouse SQL from natural language
- **Tips** — query reference, ClickHouse cheat sheet, and copy-ready example queries
- **Multi-account** — manage multiple TrafficPeak instances via a credential manager; supports JSON key file upload
- **Claude CLI integration** — any account registered via `claude mcp add` is automatically available in the UI (no duplicate entry)

---

## Prerequisites

- Node.js 18+
- Anthropic API key (for chat)
- A TrafficPeak service account token — see [Getting a token](#getting-a-trafficpeak-token)

---

## Installation

```bash
git clone https://github.com/hoejenry/trafficpeak-agent.git
cd trafficpeak-agent
npm install
npm start
```

Opens at **http://localhost:3001**

---

## Getting a TrafficPeak token

TrafficPeak is built on Grafana. There are two ways to get a token:

### Method 1 — Grafana Service Account (recommended)

1. Log in to your TrafficPeak instance (e.g. `https://<your-trafficpeak-url>`)
2. Go to **Administration → Service accounts**
3. Check whether a service account already exists for the customer. If not, create one:
   - **Name:** `<customername>_mcp_reader`
   - **Role:** `<customername>_project_reader` (read-only access to that customer's data)
4. Open the service account and click **Add service account token**
5. Give the token a name, set an expiry, and copy the generated `glsa_…` token
6. Share the token securely (e.g. [One-Time Secret](https://onetimesecret.com)) — it cannot be retrieved again

### Method 2 — Grafana MCP connection

Use an existing Grafana data source connection for MCP access. The MCP endpoint will be at `https://<your-grafana-host>/mcp`.

See the full [Akamai TrafficPeak MCP documentation](https://techdocs.akamai.com/trafficpeak/docs/mcp-server) for both connection types.

---

## Adding credentials

### Option A — JSON file upload

Create a file:
```json
{
  "name": "customer-ord",
  "url": "https://<your-trafficpeak-url>",
  "token": "glsa_..."
}
```
In the UI → **Manage Accounts** → drag-and-drop or browse to the file.

### Option B — Manual entry

In the UI → **Manage Accounts** → fill in Account name, URL, and token.

### Option C — Claude Code MCP (shared automatically)

```bash
claude mcp add --transport http mcp-trafficpeak \
  https://<your-trafficpeak-url>/mcp \
  --header "Authorization: Bearer glsa_..."
```

Any `trafficpeak.live` server registered this way appears automatically in the account dropdown with a **CLI** badge.

---

## Query constraints

| Constraint | Value |
|---|---|
| Max rows | 100,000 |
| Memory cap | 2 GiB |
| Execution timeout | 30 seconds |
| Max time range | **6 hours** (21,600 s) |
| Access | Read-only |

**SQL rules:**
- Filter on `reqTimeSec` **directly**: `WHERE reqTimeSec >= now() - INTERVAL 1 HOUR`
- Do **not** wrap `reqTimeSec` in a function — `toDate(reqTimeSec)` in WHERE is rejected
- Use **fully-qualified** table names: `nuclearregula.logs`, not just `logs`

---

## Example chat prompts

```
Show me the top 10 URLs by request volume in the last hour
What's the cache hit ratio for the last 3 hours?
Break down traffic by country for the last 2 hours
Show error rate trends over the past 6 hours
Which edge servers are handling the most traffic right now?
What's the 95th percentile response time by content type?
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TRAFFICPEAK_PORT` | `3001` | Web server port |
| `TRAFFICPEAK_URL` | — | Override: TrafficPeak base URL |
| `TRAFFICPEAK_TOKEN` | — | Override: token (skips credential file) |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Claude model for chat |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `ANTHROPIC_FOUNDRY_API_KEY` | — | Akamai Foundry API key (overrides above) |
| `ANTHROPIC_FOUNDRY_BASE_URL` | — | Akamai Foundry base URL |

---

## Credential storage

Credentials saved via the UI are stored in `~/.akamai-agent-trafficpeak.json` (mode 600). This file is never committed to git.

---

## Troubleshooting

**"No databases found" or empty schema**
- Confirm the service account token has read access to the target customer's data
- Verify the TrafficPeak URL is reachable: `curl -I https://<your-trafficpeak-url>`
- Token may have expired — generate a new one in Grafana Service Accounts

**Query times out**
- Reduce the time window — max is 6 hours
- Avoid `toDate()` or date functions on `reqTimeSec` in WHERE clauses; filter directly
- Add LIMIT to exploratory queries

**Chat gives wrong SQL**
- Switch to the **Explorer** tab and run the SQL manually to see the raw error
- Use the **Tips** tab for ClickHouse syntax reference and copy-ready examples

---

## Project structure

```
trafficpeak-agent/
├── server.js              # Express server — API routes + Claude chat
├── src/
│   ├── auth.js            # Credential management (GUI + Claude CLI)
│   └── tools/
│       └── trafficpeak.js # TrafficPeak MCP client (list, schema, query)
├── public/
│   └── index.html         # Single-page UI (Explorer + Chat + Tips)
└── package.json
```

---

## License

MIT
