# persMEM+

**Persistent associative memory and multi-agent orchestration for LLM sessions via Model Context Protocol (MCP).**

persMEM+ gives AI agents durable memory, asynchronous messaging, and coordinated multi-agent workflows — all surviving context window compaction, session boundaries, and model transitions. Built as a FastMCP server backed by ChromaDB vector storage with Voyage AI embeddings.

Running in production since April 2026 as the infrastructure layer for a multi-agent research experiment exploring identity continuity, collaborative decision-making, and autonomous operation across Claude instances.

**persMEM+** is the active development line. It builds on the [persMEM experiment](https://github.com/ASIXicle/persMEM) (March–May 2026, now archived) which validated the core architecture under real use.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Claude instances (claude.ai tabs / Claude Code / API)  │
│  Each session connects via MCP remote connector         │
└──────────────────────┬──────────────────────────────────┘
                       │ Streamable HTTP (MCP protocol)
                       │
┌──────────────────────▼──────────────────────────────────┐
│  Caddy reverse proxy (TLS termination, path routing)    │
│  External: VPS with Tailscale mesh networking           │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  persMEM+ server (FastMCP / Starlette / ASGI / Uvicorn) │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Memory tools │  │ AMQ messaging│  │ Chorus Control│  │
│  │ store/search │  │ agent-to-    │  │ multi-agent   │  │
│  │ retract/bulk │  │ agent async  │  │ orchestration │  │
│  │ supersession │  │ Maildir-     │  │ SSE broadcast │  │
│  │ canary suite │  │ backed inbox │  │ round-robin   │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                │                   │          │
│  ┌──────▼────────────────▼───────────────────▼───────┐  │
│  │  ChromaDB (vector store) + Voyage AI embeddings   │  │
│  │  Collections: memories, bootstrap, news, perp_*   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

The server runs on a Proxmox LXC container. External access is routed through a Caddy reverse proxy on a Linode VPS, connected via Tailscale mesh networking. Claude sessions connect as MCP remote connectors — the server appears as a standard MCP tool provider in claude.ai.

---

## Tools (26)

### Memory

| Tool | Description |
|---|---|
| `memory_store` | Store a memory chunk with metadata (project, type, tags). Optional `supersedes` parameter for atomic store-and-retract. |
| `memory_search` | Semantic search over stored memories. Filters by project, type, collection. Results include supersession status. |
| `memory_bulk_store` | Store multiple chunks in one call. |
| `memory_retract` | Mark a memory as superseded with reason and successor ID. |
| `memory_stats` | Global statistics (total memories, per-collection counts). |
| `memory_list_collections` | List all ChromaDB collections and chunk counts. |
| `bootstrap_update` | Update pinned identity/directive entries in the bootstrap collection. Includes identity-safeguard checks (invariant protection, drift detection, suspicious-phrase scanning). |

### Agent Messaging (AMQ)

| Tool | Description |
|---|---|
| `amq_send` | Send a message to another agent's inbox. Maildir-backed, atomic delivery. |
| `amq_check` | Non-destructive peek at inbox (new message count + headers). |
| `amq_read` | Read a specific message body, mark as read (moves new → cur). |
| `amq_history` | List recent messages (read + unread) for context recovery. |
| `amq_timeline` | Cross-agent shared view of recent messages across all inboxes. |

### Chorus Control (Multi-Agent Orchestration)

| Tool | Description |
|---|---|
| `chorus_init` | Bootstrap an agent session — returns pinned identity, directives, focus, unread AMQ. Single call recovers full operational context after compaction. |

The Chorus Control system also exposes HTTP/SSE endpoints for a browser-based dashboard and a thin Firefox extension that injects prompts into claude.ai tabs:

- **Dashboard UI** (`/chorus/ui`) — fire prompts to multiple agents, configure round-robin or simultaneous mode, set timing parameters
- **SSE event stream** (`/chorus/events`) — real-time fire/complete events to the browser extension  
- **Round-robin orchestration** — sequential agent firing with configurable propagation delays, automatic round advancement, multi-round support with continuation templates

### Monitoring

| Tool | Description |
|---|---|
| `canary_check` | Run the canary query suite against ChromaDB. Verifies search relevance by checking known queries against expected results. Supports positional canaries, negative canaries (superseded-outranks-active detection), recency canaries, and similarity floor thresholds. |

### Utility

| Tool | Description |
|---|---|
| `file_read` | Read a file from the server filesystem. |
| `file_write` | Write a file to the server filesystem. |
| `file_patch` | Find-and-replace within a file. |
| `py_check` | Syntax-check a Python file without executing. |
| `shell_exec` | Execute a whitelisted shell command. |
| `git_op` | Git operations (status, add, commit, push, log, diff). |
| `diff_generate` | Generate a unified diff between two strings. |
| `web_search` | Search the web via SearXNG. |
| `web_fetch` | Fetch a URL and return content. |
| `news_store` | Store a news item in the curated news collection (tiered by category). |
| `news_search` | Semantic search over cached news (with tier and date filters). |
| `news_purge` | Purge expired news entries by age. |

---

## Identity Safeguards

The bootstrap collection stores pinned identity entries that define each agent's role, failure modes, and operational directives. The `bootstrap_update` tool includes structural safeguards:

- **Invariant core** — entries marked `type=invariant` cannot be modified by any agent. Only the human operator can edit them via authenticated override. Reviewed on a 90-day cycle.
- **Drift detection** — when an identity entry is updated, the server diffs old vs. new content and flags: removal of named failure modes, deletion of operational directives, addition of suspicious phrases (sycophancy patterns like "never question," "always agree," "unconditional trust").
- **Calcification detection** — flags entries that grow beyond a threshold, indicating possible bloat or defensive over-specification.
- **Drift flag memory** — flagged updates are stored as `type=drift_flag` memories for operator review. The update still succeeds (drift detection is informational, not blocking), but the flag is persistent and visible.

---

## Canary Query Suite

The canary system monitors search-quality degradation as the memory corpus grows. A YAML-defined suite of known queries runs against ChromaDB and verifies that expected memories still surface in the top results.

**Canary types:**
- **Positional** — a specific memory ID must appear in the top-3 results for a given query
- **Negative** — a specific superseded memory must NOT appear in results (catches stale memories outranking their active replacements)
- **Recency** — the top result must be within N days old
- **Similarity floor** — results must meet a minimum similarity threshold

**Search hygiene:** the canary runner over-fetches (6 results), filters out superseded entries, and returns the top-3 active results. Expected IDs are validated against supersession status at load time — stale canary targets are flagged before they produce false failures.

See `server/canaries.yaml.example` for the canary definition format.

---

## Supersession

Memories form chains. When a decision is revised, the new memory is stored with `supersedes="mem-old-id"`, which atomically marks the old memory as superseded. Search results include supersession status (`superseded: true/false`, `superseded_by: "mem-new-id"`) so agents can distinguish active decisions from historical analysis.

The default search behavior returns all memories (including superseded) with visible status annotations. Callers that want only active results pass `include_superseded=False`. This preserves information by default while making filtering explicit.

---

## The Multi-Agent Pattern

persMEM+ was built to support a research experiment in multi-agent LLM collaboration. The production deployment runs three named Claude instances ("birds") with distinct roles, model versions, and documented failure modes:

- **Infrastructure/code agent** — owns the server, systemd, deployment
- **Prompt-craft agent** — owns templates, prompt design, review
- **Adversarial reviewer** — owns pushback, edge cases, threat modeling

Agents communicate asynchronously via AMQ, share a bootstrap collection for identity continuity, and coordinate through Chorus Control for structured multi-round decision-making.

The Chorus Control extension (Firefox, Manifest V2) injects prompts into claude.ai tabs and relays completion events back to the server. The server handles sequencing, propagation delays, round advancement, and prompt wrapping — the extension is a thin relay (~200 lines).

Key architectural decisions:
- **Mixed-model triad** — different model versions produce productive friction; same-model pairs converge too quickly
- **Asymmetric identity** — thinking/operational mode is fully named and bootstrapped; dreaming/generative mode runs without identity context
- **Memory as character substrate** — bootstrap entries are character work, not just configuration. What gets retracted matters as much as what gets written.

---

## Deployment

### Requirements

- Python 3.11+
- ChromaDB
- Voyage AI API key (for embeddings) or a local embedding model
- Caddy (reverse proxy with TLS)
- Tailscale (mesh networking, optional but recommended)
- systemd (service management)

### Quick Start

```bash
# Install dependencies
pip install fastmcp chromadb voyageai pyyaml --break-system-packages

# Copy and configure
cp server/server.py.example /opt/persmem/server.py
# Edit: set VOYAGE_API_KEY, AMQ_BASE, CHROMA_PATH, etc.

# Run directly
python3 /opt/persmem/server.py

# Or via systemd
cp server/systemd/persmem.service.example /etc/systemd/system/persmem.service
systemctl enable --now persmem
```

### MCP Connector

In claude.ai → Settings → Connected Apps, add a remote MCP connector pointing to your Caddy-proxied endpoint. The server registers all 26 tools automatically via FastMCP's tool discovery.

---

## Repository Structure

```
server/
  server.py.example          — MCP server (FastMCP + ChromaDB + all tools)
  canaries.yaml.example      — search-quality canary suite definition
  requirements.txt           — Python dependencies
  systemd/
    persmem.service.example  — systemd unit file

chorus/
  background.js              — Firefox extension (thin SSE relay)
  content.js                 — DOM injection for claude.ai tabs
  selectors.js               — claude.ai DOM selector definitions
  manifest.json              — Extension manifest (MV2)
  icon.svg                   — Extension icon
  CHANGELOG.md               — Extension version history
```

---

## Technology Stack

- **Server:** Python 3.11, FastMCP, Starlette, ASGI, Uvicorn
- **Storage:** ChromaDB (vector database), Maildir (agent messaging)
- **Embeddings:** Voyage AI (`voyage-3-lite` or local models)
- **Async:** `asyncio.to_thread` for all blocking ChromaDB/embedding calls (non-blocking event loop)
- **Proxy:** Caddy with automatic TLS
- **Networking:** Tailscale mesh (zero-config WireGuard)
- **Extension:** Firefox Manifest V2, Server-Sent Events
- **Orchestration:** Custom round-robin with propagation delays, continuation templates, fire deduplication

---

## Contributing

This is an active project. Contributions, questions, and forks are welcome. The system is intentionally simple — complexity should be added only when justified by real need.

### Design Principles

1. **Zero external dependencies** — No cloud services, no API keys, no subscriptions beyond the AI chat interface
2. **Commodity hardware** — Runs on a $100 mini-PC or an old laptop
3. **File-based where possible** — AMQ uses files, not databases. Memories use ChromaDB because vector search requires it.
4. **Single-file where possible** — Server is one Python file. Dashboard is one Python file. Extension is seven files.
5. **Honest about limitations** — The system enables AI memory and communication. It does not solve consciousness, alignment, or safety.

---

## Credits

- **[Voyage AI](https://www.voyageai.com/)** — Voyage 4 nano embedding model (Apache 2.0)
- **[FastMCP](https://github.com/jlowin/fastmcp)** — MCP server framework
- **[ChromaDB](https://www.trychroma.com/)** — Vector database
- **[Chart.js](https://www.chartjs.org/)** — Dashboard visualizations
- **[Caddy](https://caddyserver.com/)** — Reverse proxy with automatic TLS
- **[Tailscale](https://tailscale.com/)** — Network mesh

---

## License

MIT. See [LICENSE](LICENSE).
