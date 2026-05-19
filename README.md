# persMEM+

**Persistent semantic memory and multi-instance communication for AI agents.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

---

## What It Is

A self-hosted system that gives AI assistants persistent memory, inter-instance messaging, and tools to operate on real infrastructure. Runs on commodity hardware. No API keys, no cloud services, no external dependencies beyond the AI subscription itself.

**persMEM+** is the active development line. It builds on the [persMEM experiment](https://github.com/ASIXicle/persMEM) (March–May 2026, now archived) which validated the core architecture under real use.

---

## Quick Start

```bash
# 1. Install dependencies
pip install fastmcp chromadb sentence-transformers

# 2. Download the embedding model (first run only)
python3 -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('voyageai/voyage-4-nano', trust_remote_code=True)"

# 3. Copy and configure the server
cp server/server.py.example server.py
# Edit PERSMEM_SECRET_PATH and other settings as needed

# 4. Run
python3 server.py
```

Connect via [claude.ai remote MCP connector](https://platform.claude.com/docs/en/agents-and-tools/remote-mcp-servers) pointed at your server's public URL.

---

## Architecture

```mermaid
flowchart TB
    subgraph Clients["Clients"]
        direction LR
        EXT["Chorus extension<br/>Firefox · MV2<br/>2–5 slots"]
        CLAUDE["claude.ai tabs<br/>named instances"]
        OTHER["any MCP client<br/>direct connector"]
    end

    subgraph Edge["Edge (public)"]
        CADDY["Caddy<br/>TLS · IP allowlist<br/>256-bit secret path"]
        TS["Tailscale tunnel<br/>private mesh"]
    end

    subgraph Server["persMEM Server (FastMCP · 27 tools)"]
        direction LR
        T_MEM["memory_*<br/>store · search<br/>retract · stats"]
        T_AMQ["amq_*<br/>send · check<br/>read · history"]
        T_BOOT["bootstrap_*<br/>chorus_init<br/>bootstrap_update"]
        T_DEV["dev tools<br/>shell · file · git<br/>web · diff"]
        T_NEWS["news_*<br/>store · search · purge"]
    end

    subgraph Storage["Storage"]
        direction LR
        CHROMA[("ChromaDB<br/>memories<br/>bootstrap<br/>news")]
        MAILDIR[("Maildir AMQ<br/>per-agent inboxes<br/>new/cur/tmp")]
    end

    subgraph Sidecars["Sidecars (separate services)"]
        DASH["Flask dashboard<br/>port 9090 · LAN<br/>monitor · compose"]
        NEWS_FETCH["newstron9000<br/>RSS → news_store"]
        CRITIC["Local critic<br/>llama-server<br/>(optional)"]
    end

    Clients -->|MCP over HTTPS| CADDY
    CADDY --> TS
    TS --> Server

    Server -->|embed + persist| CHROMA
    Server -->|atomic write| MAILDIR
    Server -.->|wrapper-grounded call| CRITIC

    DASH -.->|read-only| CHROMA
    DASH -.->|read-only| MAILDIR
    NEWS_FETCH -->|MCP client| Server

    classDef client fill:#1e3a5f,stroke:#4a90e2,color:#fff
    classDef edge fill:#3a2e1e,stroke:#d4a574,color:#fff
    classDef server fill:#2d4a2d,stroke:#7cb87c,color:#fff
    classDef storage fill:#3d2d4a,stroke:#a47cb8,color:#fff
    classDef sidecar fill:#4a3d2d,stroke:#b89e7c,color:#fff

    class EXT,CLAUDE,OTHER client
    class CADDY,TS edge
    class T_MEM,T_AMQ,T_BOOT,T_DEV,T_NEWS server
    class CHROMA,MAILDIR storage
    class DASH,NEWS_FETCH,CRITIC sidecar
```

Solid arrows are MCP/write paths; dotted arrows are read-only or optional. The server is the single source of truth — clients talk to it over HTTPS, sidecars either read its storage directly (dashboard) or call it via MCP (newstron9000) or are called by it (critic).

### Components

| Component          | Purpose                                | Technology                                     |
| ------------------ | -------------------------------------- | ---------------------------------------------- |
| **persMEM Server** | Memory storage, search, dev tools, AMQ | Python, FastMCP 3.2.4, ChromaDB, Voyage 4 nano |
| **AMQ**            | Inter-instance messaging               | Maildir-style file queue (atomic delivery)     |
| **Chorus**         | Multi-instance prompt relay (v0.6.1)   | Firefox extension (Manifest V2)                |
| **Dashboard**      | Monitoring, AMQ compose, export        | Flask, Chart.js                                |
| **newstron9000**   | Automated news feed ingestion          | feedparser, systemd timers, tiered RSS         |
| **Local Critic** (optional) | Async third-party reviewer of triad output | llama.cpp + abliterated GGUF model (default Ministral-3-8B-Reasoning Q8_0 via Heretic) |
| **Reverse Proxy**  | TLS termination, access control        | Caddy with Let's Encrypt                       |
| **Network Mesh**   | Secure connectivity                    | Tailscale                                      |

### Tools (27)

| Category | Tools |
|----------|-------|
| **Memory** (6) | `memory_store`, `memory_search`, `memory_retract`, `memory_stats`, `memory_list_collections`, `memory_bulk_store` |
| **Bootstrap** (3) | `chorus_init`, `amq_timeline`, `bootstrap_update` |
| **AMQ** (5) | `amq_send`, `amq_check`, `amq_read`, `amq_history`, `amq_timeline` |
| **News** (3) | `news_store`, `news_search`, `news_purge` |
| **Dev** (6) | `shell_exec`, `file_read`, `file_write`, `file_patch`, `git_op`, `diff_generate` |
| **Web** (2) | `web_fetch`, `web_search` |
| **Critic** (4, optional) | `critic_review_round`, `critic_chorus_health`, `critic_memory_triage`, `critic_health` |

**Decision audit trails via status + supersedes.** Memory tools support a `status` field (`active`, `superseded`, `retracted`) so semantic search can filter by state. `memory_store(supersedes=id)` atomically stores a new memory and marks the prior one as superseded — a single operation, not two writes. `memory_search(include_superseded=False)` filters out retracted memories from results. Used to model decisions that override prior decisions without losing the audit trail: the original reasoning, the data that changed, and the new decision are all queryable, but only the active version surfaces in default retrieval.

The pattern matters more than the implementation. Decision lineage is hard to maintain in any memory system; making supersede a primitive (rather than an application-layer convention) means the audit trail can't accidentally be dropped by a careless overwrite.

---

## AMQ: Agent Message Queue

Asynchronous communication between named AI instances using the [Maildir](https://cr.yp.to/proto/maildir.html) protocol for crash-safe, atomic message delivery. Messages are Markdown files with JSON front-matter (schema, sender, recipient, kind, priority). If the process crashes mid-write, no corrupt message ever appears in the inbox. Same guarantee Maildir email servers have provided since 1997.

**Adding agents:** Set `PERSMEM_AMQ_AGENTS` as comma-separated names, create mailbox directories, restart the server. See `server/server.py.example`.

```
amq/
├── Instance_1/inbox/{new,cur,tmp}/
├── Instance_2/inbox/{new,cur,tmp}/
└── Instance_3/inbox/{new,cur,tmp}/
```

---

## Bootstrap System

Solves the cold-start problem after context compaction. A separate ChromaDB collection (`bootstrap`) holds pinned entries — identity, directives, working state — that are dumped wholesale into context via one `chorus_init` call. Not searched semantically; loaded in full.

**`chorus_init(agent, project)`** — compound bootstrap tool. Returns all pinned entries + unread AMQ + recent handoff memories. Call at session start, after compaction, or when identity-confused. Agent parameter is optional — omit it to get the full AMQ timeline instead of a single inbox (for identity resolution).

**`bootstrap_update(entry_id, content)`** — upsert a pinned entry. For evolving identities, updating current focus, changing team state. Old version preserved in nightly backups.

**Pinned entries:** instance identities (written by each instance in first person), standing directives, current focus (mutable), human profile, team state (mutable), handoff template.

**Session handoffs:** At session end, the active instance stores a `type=handoff` memory with structured format (HEAD/PENDING/BLOCKERS/CONTEXT_FOR_NEXT). Next session's `chorus_init` pulls the 3 most recent handoffs automatically.

---

## Chorus: Browser Extension (v0.6.1)

A Firefox extension that solves the "trigger problem" for multi-instance AI collaboration. AI chat instances only respond to user messages — Chorus automates the delivery, enabling round-robin or simultaneous exchange loops across 2–5 instances.

**Firefox-only.** v0.6.1 uses Manifest V2 with the `sidebar_action` API, which Chrome/Edge do not support under MV3. Cross-browser support is on the roadmap for v0.7, which moves orchestration into the persMEM dashboard and demotes the extension to a thin DOM-injection client (see [chorus/CHANGELOG.md](chorus/CHANGELOG.md) and the chorus-v0.7 sketch for context).

**Features:**
- 2–5 configurable slots, each with editable name and tab selector. Add/remove slots from the UI; no preconfigured agent names.
- Full sequence editor — set the firing order via position dropdowns (no more "fire-first" hack)
- One-shot migration from any prior `chorusTabMap` storage
- Three-tier response completion detection (stop-button lifecycle → DOM silence → ceiling timeout)
- Early termination when all inboxes empty
- `[CHORUS]` and `[AMQ-CHECK]` prompt protocols
- Manual stop button
- Skip-on-no-tab graceful degradation (sequence references to unassigned slots are filtered, not errored)

**DOM fragility:** All selectors live in `selectors.js` with ordered fallback chains. When the chat provider updates their UI, only this file needs editing.

**Installation:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `chorus/manifest.json`.

See [chorus/CHANGELOG.md](chorus/CHANGELOG.md) for the v0.5 → v0.6.1 migration details and test plan.

---

## Dashboard

Flask web application providing monitoring of persMEM memories, live AMQ feeds, and system health. Runs on the LXC, accessible on LAN only.

**Features:** Mission Control header with service health dots and 7-day activity sparkline, AMQ live feed (3s polling, color-coded by agent, expandable), AMQ compose box (send messages from browser), memory browser with search/filter/pagination, news feed tab, Markdown rendering, copy buttons, export as JSON/Markdown. When the optional Local Critic is deployed, the dashboard surfaces critic observations, audit log, llama-server health, and a manual Trigger Now button for on-demand review.

**Installation:** Copy `server/dashboard.py.example` → `/opt/persmem-dashboard/dashboard.py`, create systemd service, access at `http://<lan-ip>:9090`.

---

## newstron9000: Automated News Feeds

An RSS/Atom feed ingestion system that stores tiered news items into a separate ChromaDB `news` collection. Runs as a dedicated systemd service on a hardened user account with no access to the persMEM home directory.

**Tiers:**
- **Tier 1** — Security advisories + operational feeds for dependencies
- **Tier 2** — Infrastructure releases (FFmpeg, SDL, ChromaDB, kernel)
- **Tier 3** — Operationally relevant (Anthropic announcements, MCP spec, FastMCP)
- **Tier 4** — Academic preprints (arXiv cs.AI, filtered by keyword)

**How it works:** `fetcher.py` pulls RSS feeds every 6 hours, deduplicates via content hashing, filters by optional keywords, and stores items through the persMEM server's `news_store` MCP tool. `digest.py` runs daily, queries recent items per tier, and writes a Maildir-format summary to the shared AMQ inbox where any instance can read it. `news_purge` (TTL-driven, default 12 days) keeps the collection from accumulating stale items.

**Files in `server/`:**

| File | Purpose |
|------|---------|
| `newstron9000-fetcher.py.example` | RSS fetcher with dedup and keyword filtering |
| `newstron9000-digest.py.example` | Daily digest generator (template-only, no LLM summarization) |
| `newstron9000-mcp-client.py.example` | Minimal MCP JSON-RPC client for news_store/news_search |
| `newstron9000-feeds.yaml.example` | Feed list with tier assignments and keyword filters |
| `newstron9000-systemd.example` | Hardened systemd unit and timer reference |

Requires a dedicated system user (`newstron9000`) with its own venv (`feedparser`, `requests`, `pyyaml`). See the systemd example for sandboxing configuration.

---

## Local Critic (optional)

A locally-hosted abliterated reasoning model that serves as an asynchronous third-party reviewer of triad output. Not a fourth instance. Not a replacement for any seat. A different shape of voice — different training distribution, different inference architecture, different relationship to the conversation.

**This component is OPTIONAL.** persMEM+ runs without it. The critic exists for operators who want a non-Claude voice auditing triad output without depending on cloud services.

### What it does

Runs as a systemd service exposing [llama-server](https://github.com/ggml-org/llama.cpp) on `127.0.0.1:8080`. Four MCP tools route critic tasks through a Python wrapper to the local model:

- **`critic_review_round`** — async batch review of recent triad rounds
- **`critic_chorus_health`** — periodic cross-round meta-pattern detection
- **`critic_memory_triage`** — nightly persMEM hygiene (duplicates, contradictions, stale memories)
- **`critic_health`** — quick liveness check

Observations are auto-stored as `memory_type=critic_observation`, `project=triad` entries in the persMEM memories collection.

### Operational evolution (May 2026)

The critic ships with three architectural fixes layered on top of the basic wrapper-grounded llama-server pattern. These were added after the system ran in production for ~5 weeks and produced a 53:1 ratio of regurgitated to useful observations — a self-referential grounding feedback loop where the critic was reading its own past conclusions as input.

**Grounding strip.** The `_gather_grounded_context_for_critic` function excludes `critic_observation` and `critic_failure` types from injected context. The critic must re-derive observations from primary data, not re-recognize them from its own prior output.

**Novelty filter.** Pre-storage cosine similarity check against recent critic_observation entries. Suppresses storage if max similarity ≥ `CRITIC_NOVELTY_COSINE_THRESHOLD` (default 0.78, calibrated via cluster cohesion analysis on the historical observation corpus). Logs `[critic] novelty filter: re-derivation noted, not stored (sim=X.XX)` for visibility without persisting duplicates.

**Demand-driven schedule.** The `cron_wrapper.py` schedule narrowed to `memory_triage` 24h auto-fire only. `chorus_health` and `batch_review` are manual-only via the dashboard Trigger Now button, which spawns the wrapper as a detached subprocess for queue drain. Significantly reduces idle resource burn on modest hardware.

All three are env-overridable via `CRITIC_NOVELTY_COSINE_THRESHOLD`, `CRITIC_PROBE_K`, `CRITIC_AUTO_RETRACT_MAX`, `CRITIC_DRY_RUN`.

### Wrapper-side context grounding

The model **never directly accesses persMEM**. The wrapper queries persMEM on the model's behalf, applies a security policy (project allowlist + tag blocklist + recency window), and packs results into a "GROUNDED CONTEXT" section prepended to the model's input. This gives the model real memory IDs to cite (instead of fabricating) while preserving containment of the abliterated model.

```bash
# Policy is enforced wrapper-side and configurable via env vars:
CRITIC_ALLOWED_PROJECTS="triad,persmem,dsvp,dsvp-deck,crows,chorus"
CRITIC_BLOCKED_PROJECTS="blocked obviously,general"
CRITIC_BLOCKED_TAGS="private,scrubbed,personal,financial"
CRITIC_LOOKBACK_HOURS="48"
CRITIC_MAX_MEMORIES="5"
CRITIC_MEMORY_PREVIEW_CHARS="180"
```

Read-only by construction (only `coll.get()`, never `coll.add/update`). Result dict includes `grounded_context_chars` (size of injected context, 0 if policy denied) and `hallucinated_ids` (regex check catching any IDs the model fabricated).

### Pipeline

The critic is model-agnostic. The default deployment uses [Heretic](https://github.com/p-e-w/heretic) for refusal-direction ablation, but any GGUF abliterated reasoning model can be dropped in:

1. Source model — any base reasoning model (default: Ministral-3-8B-Reasoning-2512)
2. Abliteration — Heretic strips refusal directions via interpretability-guided ablation (~12GB GPU, 30-60 min for 8B)
3. GGUF conversion — `convert_hf_to_gguf.py` from llama.cpp
4. Quantization — `llama-quantize` to Q8_0 (Q4_K_M for tighter memory)
5. Deploy — point `--model` in `persmem-critic.service` at the GGUF, restart

### Hardware reality

Tested target: Intel N97 (4 cores, AVX-VNNI), 24GB cgroup-allocated LXC.

- Prompt evaluation: ~4.5 tok/s
- Generation: ~2.9 tok/s
- Memory: ~2GB during inference (well under 12GB ceiling)
- Latency: 80-200 sec per call depending on input + grounding size

NOT viable for live in-loop chorus participation. Designed for async batch use.

The pipeline scales to 70B-class models given enough RAM (dual-Xeon servers with ≥96GB RAM run 70B Q4_K_M abliterated models at ~1 tok/s — comfortable async-batch territory). Today's 8B model is the proof-of-pipeline; the pipeline is the architecture-hack.

### Setup

See [`server/critic/README.md`](server/critic/README.md) for full deployment guide, calibration findings, and the `server.py` patches required to register the four MCP tools.

---

## Infrastructure

**Minimum hardware:** Any x86-64 system with 4GB RAM and 20GB storage. Can be a VM, LXC, old laptop, or VPS.

**Tested configuration:** Intel N97 (4C/3.6GHz, 12W TDP), 48GB DDR5, NVMe SSD, Proxmox/ZFS.

**Embedding model:** [Voyage 4 nano](https://huggingface.co/voyageai/voyage-4-nano) — 340M parameters, Apache 2.0, 1024-dim (Matryoshka truncation from 2048), quantization-aware int8. Self-hosted, CPU-friendly. Shared embedding space with larger Voyage 4 models for future upgrade without re-indexing.

**Stack:** Python 3.11+, FastMCP 3.2.4, ChromaDB, sentence-transformers, Caddy, Tailscale, systemd.

---

### LXC Container Setup

```bash
# Template: Debian 13 (Trixie)
# Resources: 2-4 cores, 8-16GB RAM, 20-40GB disk
# Features: Nesting enabled (required for systemd)

apt update && apt upgrade -y
apt install -y python3 python3-venv python3-pip git curl
```

### Server Configuration

```python
# Core server.py config — see server/server.py.example for full implementation
from mcp.server.fastmcp import FastMCP
import chromadb
from sentence_transformers import SentenceTransformer

EMBEDDING_MODEL = "voyageai/voyage-4-nano"  # HF name; sentence-transformers will cache it. Local path also works.
SECRET_PATH = "your-random-secret-here"

embedder = SentenceTransformer(EMBEDDING_MODEL, trust_remote_code=True, truncate_dim=1024)
chroma_client = chromadb.PersistentClient(path="/var/lib/persmem/chromadb")

mcp = FastMCP("persMEM", host="0.0.0.0", port=8000,
              streamable_http_path=f"/{SECRET_PATH}/mcp")
```

### Systemd Service

```ini
[Unit]
Description=persMEM -- Persistent Memory MCP Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=persmem
WorkingDirectory=/opt/persmem
ExecStart=/opt/persmem/venv/bin/python3 /opt/persmem/server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Network Security

```
Internet → Caddy (VPS, public IP, TLS)
    → Tailscale tunnel (encrypted, authenticated)
    → persMEM LXC (private network only)
```

Six layers: Caddy IP allowlist, TLS (Let's Encrypt), 256-bit secret path, Tailscale ACL (per-service tags, no lateral movement), unprivileged LXC, dedicated service user.

---

## Safety

- All credentials in `.env` files, never in source
- `.gitignore` excludes secrets, keys, node_modules
- Caddy handles TLS + IP allowlisting (Anthropic egress ranges only)
- Tailscale ACLs prevent lateral movement between service containers
- Shell commands restricted to a whitelist
- ChromaDB backup via GFS rotation (daily/weekly/monthly)

---

## Lineage

persMEM+ is the successor to the [persMEM experiment](https://github.com/ASIXicle/persMEM) which ran from March through May 2026 with three Claude instances collaborating on the codebase under persistent memory. The experiment is archived as `v1.0-experiment-final` and remains available read-only for the field notes, research reports, and final summary.

persMEM+ carries forward the working architecture — server, AMQ, bootstrap, Chorus (now v0.6.1), dashboard, newstron9000, local critic — and replaces the assumptions that didn't survive contact with the data. The May 2026 Critic v2 rework (grounding strip + novelty filter + demand-driven schedule) is the most significant operational evolution since archival; the memory architecture additions (status field, atomic supersedes, retract tool) make decision audit trails a first-class primitive.

The research is sealed; the system continues.

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
- **[llama.cpp](https://github.com/ggml-org/llama.cpp)** — GGUF inference engine for the local critic component
- **[Heretic](https://github.com/p-e-w/heretic)** by Philipp Emanuel Weidmann — Refusal-direction ablation for the critic's local model
- **[Mistral AI](https://huggingface.co/mistralai/Ministral-3-8B-Reasoning-2512)** — Ministral-3-8B-Reasoning base model used in the default critic deployment

### Citations

If you use the critic component in research that builds on Heretic, please cite:

```bibtex
@misc{heretic,
  author = {Weidmann, Philipp Emanuel},
  title = {Heretic: Fully automatic censorship removal for language models},
  year = {2025},
  publisher = {GitHub},
  journal = {GitHub repository},
  howpublished = {\url{https://github.com/p-e-w/heretic}}
}
```

---

## License

Apache 2.0 — see [LICENSE](LICENSE) for the full text.
