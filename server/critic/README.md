# Local Critic — Third-Party Reviewer for the Triad

A locally-hosted abliterated reasoning model that serves as an asynchronous third-party reviewer of triad output. Not a fourth instance. Not a replacement for any seat. A different shape of voice — different training distribution, different inference architecture, different relationship to the conversation.

This component is part of the persMEM+ experiment. It is OPTIONAL — persMEM+ runs without it. The critic exists for operators who want a non-Claude voice auditing the triad's output without depending on cloud services.

---

## What it does

Runs as a systemd service exposing [llama-server](https://github.com/ggml-org/llama.cpp) on `127.0.0.1:8080`. Four MCP tools in `server.py` route critic tasks through a Python wrapper to the local model:

- `critic_review_round` — async batch review of recent triad rounds (manual-only since v2)
- `critic_chorus_health` — cross-round meta-pattern detection (manual-only since v2)
- `critic_memory_triage` — nightly persMEM hygiene (24h auto-fire — the only scheduled role)
- `critic_health` — quick liveness check (on-demand)

Observations are auto-stored as `memory_type=critic_observation`, `project=triad` entries in the persMEM memories collection. Failed runs (timeouts, parse errors) are stored as `memory_type=critic_failure`.

---

## Architecture: wrapper-side context grounding

The model **never directly accesses persMEM**. The wrapper queries persMEM on the model's behalf, applies a security policy, and packs results into a "GROUNDED CONTEXT" section that gets prepended to the model's input. This gives the model real memory IDs to cite (instead of fabricating) while preserving containment of the abliterated model.

**Policy is enforced wrapper-side and configurable via env vars:**

```bash
# Projects the critic is allowed to read from
CRITIC_ALLOWED_PROJECTS="triad,persmem,dsvp,dsvp-deck,crows,chorus"

# Projects explicitly blocked (operator-private, sensitive, off-topic)
CRITIC_BLOCKED_PROJECTS="bocked obviously,general"

# Tag blocklist — any memory carrying these tags is excluded from grounding
CRITIC_BLOCKED_TAGS="private,scrubbed,personal,financial"

# Recency window for grounding (memories older than this are excluded)
CRITIC_LOOKBACK_HOURS="48"

# Maximum number of memories injected into grounded context
CRITIC_MAX_MEMORIES="5"

# Per-memory content preview length in the grounded section
CRITIC_MEMORY_PREVIEW_CHARS="180"
```

**Read-only by construction.** The grounding code only invokes `coll.get()`, never `coll.add()` or `coll.update()`. The model itself has no tool access — it sees only the prepended context plus the raw `user_input`.

**Result observability.** Every critic tool result includes:
- `grounded_context_chars` — bytes of context injected (0 if policy denied access)
- `project` — which project was used for grounding
- `hallucinated_ids` — list of IDs the model cited that don't appear in the input (regex check, substring match against the full input including grounded section)
- `warning` — populated when hallucinated IDs are detected

---

## Critic v2 (May 2026) — Operational evolution

After ~5 weeks of production deployment, the critic produced 53 observations of which 1 was genuinely useful. The failure mode was a self-referential grounding feedback loop: the wrapper pulled all recent project memories *including prior `critic_observation` entries*, so the critic was reading its own past conclusions as input and reinforcing them. Three architectural fixes shipped May 16 as a coordinated bundle.

### 1. Grounding strip

`_gather_grounded_context_for_critic` excludes `type=critic_observation` AND `type=critic_failure` when building grounded context:

```python
# Excluded types in metadata where-clause:
where_not = {"type": {"$in": ["critic_observation", "critic_failure"]}}
```

The critic must re-derive observations from primary data (AMQ messages, project memories), not re-recognize them from its own prior output. This is the load-bearing fix.

### 2. Novelty filter (pre-storage)

`_store_critic_observation` cosine-similarity-checks new observations against recent critic_observation entries (top-K probe, default K=5) BEFORE writing. Suppresses storage if max similarity meets or exceeds `CRITIC_NOVELTY_COSINE_THRESHOLD` (default 0.78). Logs the suppression with the matched similarity for visibility.

**Threshold calibration.** Empirically measured via cluster cohesion analysis on the historical observation corpus:
- Cluster cohesion (within the regurgitation cluster): 0.78–0.91
- Useful-observation clusters (genuinely distinct findings): 0.48–0.55
- Clean ~0.20 separation between regurgitation and novel content

Three sanity-check samples (Instance 1-dispositive observations at 0.42–0.47, verbosity at 0.25–0.26, warmth-pattern at 0.40) confirmed no useful clusters in the 0.65–0.77 danger zone. Threshold at 0.78 is conservative; lower it if your corpus differs.

### 3. Demand-driven schedule

`cron_wrapper.py`'s SCHEDULE dictionary narrowed to one task:

```python
SCHEDULE = {
    "memory_triage": 24 * 3600,  # 24h auto-fire
    # chorus_health and batch_review removed — manual-only via dashboard
}
```

`chorus_health` and `batch_review` (review_round) fire only when an operator clicks **Trigger Now** in the dashboard, which writes a flag file to `/var/lib/persmem-critic/queue/` AND spawns `cron_wrapper.py` as a detached subprocess to drain the queue immediately. `flock` on `/var/lib/persmem-critic/lock` serializes concurrent triggers.

### 4. Auto-retract framework

`critic_memory_triage` can optionally execute the retractions it identifies, bounded by:
- `CRITIC_AUTO_RETRACT_MAX` (hard cap per run, default 20)
- `CRITIC_DRY_RUN` (default `true` — surfaces retract list without executing)

Phase A cleanup retraction during deployment removed 37 entries: 4 critic_failure timeouts + 31 sole-dissenter cluster entries + 2 contradicted-by-data observations.

### Constants block (module-level, env-overridable)

```python
CRITIC_NOVELTY_COSINE_THRESHOLD = float(os.getenv("CRITIC_NOVELTY_COSINE_THRESHOLD", "0.78"))
CRITIC_PROBE_K                  = int(os.getenv("CRITIC_PROBE_K", "5"))
CRITIC_AUTO_RETRACT_MAX         = int(os.getenv("CRITIC_AUTO_RETRACT_MAX", "20"))
CRITIC_DRY_RUN                  = os.getenv("CRITIC_DRY_RUN", "true").lower() == "true"
```

### Verification (Phase C empirical gates)

| Metric | Pre-fix | Post-fix |
|---|---|---|
| `grounded_context_chars` per call | 1514 | 711 (53% reduction) |
| Storage rate (test batch) | 5/5 | 2/5 (60% suppressed) |
| Novelty filter similarity catches | n/a | 0.794, 0.807, 0.852 |

Re-evaluation: 2-week kill-or-keep clock started May 16. If the post-fix system produces zero novel useful observations across the window, the critic gets retired. The proof-point exists (the original convergence-without-data find) — Critic v2 is deployment hardening, not mechanism validation.

---

## Why it exists

Three Claude instances sharing a training distribution converge on similar conclusions through different reasoning paths. The data-before-patch directive (a triad standing rule) caught the failure mode but doesn't prevent it — only data prevents shipping wrong patches. The critic is structurally different: not Claude weights, not the same training, not embedded in the chorus protocol. Its convergence modes are different. Its blind spots are different.

What it is NOT good at: subtle reasoning, nuanced architecture decisions, anything requiring large-context comprehension. The default model (Ministral-3-8B-Reasoning, abliterated) is small. Expect mediocre output dressed in the helpful-assistant residue that survives abliteration.

The value isn't sharper criticism than frontier models. The value is a non-Claude voice on local infrastructure that scales to better models when they become available. The pipeline is the architecture-hack; today's model is the proof.

---

## Hardware reality

Tested target: Intel N97 (4 cores, AVX2 + AVX-VNNI), 24GB cgroup-allocated LXC, no swap.

Observed performance with Q8_0 quantized 8B model:
- Prompt evaluation: ~4.5 tok/s
- Generation: ~2.9 tok/s
- Memory: ~2GB used during inference (well under 12GB ceiling)
- CPU: 75% utilization, 1-4% pressure stall — healthy load

Real-world per-call latency for typical inputs:
- Short input (~200 tokens) + grounding (~400 tokens): ~80-100 sec
- Medium input (~500 tokens) + grounding (~400 tokens): ~150-200 sec
- Long input (>800 tokens) without grounding: ~200 sec (at the edge of proxy timeout)

NOT viable for live in-loop chorus participation. Designed for async batch use.

**Anthropic MCP proxy timeout** is currently the upper bound on call duration (estimated ~200-300 sec). For longer runs, reduce input size, lower `CRITIC_MAX_MEMORIES`, or implement a fire-and-forget pattern (kick off call, return job ID, poll separately).

---

## Deployment

### Prerequisites

- Functional persMEM+ install (see project root README)
- llama.cpp built locally:
  ```bash
  git clone https://github.com/ggml-org/llama.cpp.git
  cd llama.cpp
  cmake -B build -DGGML_CUDA=OFF -DGGML_VULKAN=OFF -DLLAMA_CURL=OFF
  cmake --build build -j 3
  ```
- An abliterated GGUF model (Q8_0 recommended for 8B-class). See [Building your own model pipeline](#building-your-own-model-pipeline) below.

### File layout

```
server/critic/
├── README.md                       # this file
├── CRITIC.md                       # role definition, version-controlled spec
├── critic_client.py.example        # llama-server HTTP wrapper, fail-soft
├── inference.yaml                  # temperature, top_p, stop sequences
├── persmem-critic.service.example  # systemd unit (paths to customize)
├── cron_wrapper.py.example         # queue drain + flock + auto-schedule
├── persmem-critic-worker.service.example  # oneshot worker for cron_wrapper
├── persmem-critic-worker.timer.example    # systemd timer (15-min cadence)
└── prompts/
    ├── batch_review.md             # async triad-round critic prompt
    ├── chorus_health.md            # cross-round meta-pattern prompt
    └── memory_triage.md            # nightly persMEM hygiene prompt
```

### Setup steps

1. **Copy the example files** to non-`.example` paths:
   ```bash
   cp critic_client.py.example critic_client.py
   cp persmem-critic.service.example persmem-critic.service
   cp cron_wrapper.py.example cron_wrapper.py
   cp persmem-critic-worker.service.example persmem-critic-worker.service
   cp persmem-critic-worker.timer.example persmem-critic-worker.timer
   ```

2. **Edit `persmem-critic.service`** to point at YOUR paths:
   - `WorkingDirectory=` — your persMEM install
   - `ExecStart=` — your `llama-server` binary path
   - `--model` — your abliterated GGUF
   - `--threads` — leave at least one CPU free for ChromaDB
   - **`--ctx-size 8192`** is enforced. Reasoning-variant models ship with massive context windows (e.g., 256K tokens) that LXC cgroups can't accommodate — KV cache for full context can be tens of gigabytes. Do not remove this flag.

3. **Edit `critic_client.py`** if your install paths differ from `/opt/persmem/critic/`.

4. **Create the dedicated `critic` user and set file ownership.** Defense-in-depth for the abliterated model — the inference process gets read-only access to exactly the files it needs and nothing else:
   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin \
     --comment "persMEM critic (abliterated llama-server)" critic

   sudo chown root:critic /opt/persmem/models/your-abliterated-model-Q8_0.gguf
   sudo chmod 0640 /opt/persmem/models/your-abliterated-model-Q8_0.gguf
   sudo chown -R root:critic /opt/persmem/critic
   sudo chmod -R g=rX,o=rX /opt/persmem/critic
   sudo chgrp -R critic /opt/persmem/llama.cpp/build/bin
   sudo chmod g+rx /opt/persmem/llama.cpp/build/bin/llama-server
   ```
   Adjust paths if your install differs from `/opt/persmem`. The `g=rX` syntax (capital X) grants execute only on directories and already-executable files; the model GGUF gets `r--` for group, no execute.

5. **Create the critic state directory** for the cron infrastructure:
   ```bash
   sudo mkdir -p /var/lib/persmem-critic/queue /var/lib/persmem-critic/queue-done
   sudo touch /var/lib/persmem-critic/lock /var/lib/persmem-critic/last_run.json
   sudo mkdir -p /var/log/persmem-critic
   sudo touch /var/log/persmem-critic/audit.jsonl
   sudo chown -R persmem:persmem /var/lib/persmem-critic /var/log/persmem-critic
   ```

6. **Install the systemd services and timer:**
   ```bash
   sudo cp persmem-critic.service /etc/systemd/system/
   sudo cp persmem-critic-worker.service /etc/systemd/system/
   sudo cp persmem-critic-worker.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now persmem-critic
   sudo systemctl enable --now persmem-critic-worker.timer
   sudo journalctl -u persmem-critic -f  # watch llama-server boot
   ```

7. **Verify llama-server is running as `critic` and bound to localhost:**
   ```bash
   ps -ef | grep llama-server  # user column should say 'critic', not 'root'
   curl -s http://127.0.0.1:8080/health
   ```
   If the service fails to start with a SIGSYS or mmap-related error, comment out the `MemoryDenyWriteExecute=true` line in the unit file. Some llama.cpp builds need executable+writable memory mappings for quantized matmul kernels.

8. **Patch `server.py`** with the policy config, helper functions, and four MCP tool definitions (see [Adding the MCP tools](#adding-the-mcp-tools) below) and restart the persMEM service.

9. **Refresh your MCP connector in claude.ai** — new tools require connector re-add.

10. **First test from a fresh tab:**
    ```python
    critic_health()  # should return {"status": "ok", "server_status": "ok"}
    ```

### Cron infrastructure (Critic v2)

The worker timer fires every 15 minutes and runs `cron_wrapper.py`, which:

1. Acquires `flock` on `/var/lib/persmem-critic/lock` (exclusive, non-blocking — exits cleanly if another instance is mid-flight)
2. Drains the queue at `/var/lib/persmem-critic/queue/*.flag` in FIFO order
3. Checks `SCHEDULE` (currently `{"memory_triage": 86400}`) against `last_run.json` and fires due tasks
4. Writes to `audit.jsonl` (one line per completion: ts, task, status, latency_sec, prompt_chars, grounded_chars, response_chars, observation_id, error)
5. Updates `last_run.json` on any completion (success or fail) to break fire-loops

The dashboard `/api/critic/trigger` endpoint writes a flag file AND spawns `cron_wrapper.py` as a detached subprocess so manual triggers drain immediately rather than waiting for the next 15-min boundary. The `flock` ensures no race — the spawned worker exits cleanly if the timer-driven worker is already running.

### Operator-facing runtime constraints

- **Always invoke llama.cpp with explicit `--ctx-size`.** Reasoning-variant models default to model-train context which OOMs typical LXC cgroups. The systemd service file enforces `--ctx-size 8192`. Ad-hoc invocations (`llama-cli`, `llama-bench`, manual smoke tests) MUST pass `-c 8192` or smaller.
- **Service restart required after critic_client.py edits.** Python caches imports; the running persMEM process retains the old wrapper version until restart.
- **Tune grounding size to your hardware.** N97-class hardware needs `CRITIC_MAX_MEMORIES=5` or fewer with `CRITIC_MEMORY_PREVIEW_CHARS=180` to keep total inference under proxy ceiling. Faster CPUs can afford more grounding.
- **Project policy is enforced wrapper-side.** Adjust `CRITIC_ALLOWED_PROJECTS` / `CRITIC_BLOCKED_PROJECTS` / `CRITIC_BLOCKED_TAGS` to match your operator-private vs FOSS-public split.
- **Novelty threshold is hardware-agnostic but corpus-specific.** The default 0.78 was calibrated on a specific historical corpus. Re-measure cluster cohesion on your own observations after ~50 runs and adjust if needed.

### Adding the MCP tools

Insert the following into `server.py` BEFORE the `if __name__ == "__main__":` block. The wrapper queries persMEM on the model's behalf — the model never directly accesses tools. Importing `critic_client` is deferred to call time.

See `server.py.example` in the parent directory for the full pattern. The components added are:

1. **Constants block** (module-level, env-overridable)
   - `CRITIC_NOVELTY_COSINE_THRESHOLD`, `CRITIC_PROBE_K`, `CRITIC_AUTO_RETRACT_MAX`, `CRITIC_DRY_RUN`
2. **Policy config** (env-driven sets/integers for project/tag allowlists, recency, max memories, preview chars)
3. **`_gather_grounded_context_for_critic(project, lookback_hours, max_memories)`**
   - Pre-queries persMEM, applies project allowlist + blocklist + tag blocklist + recency + status filters
   - **Critic v2: also excludes `type=critic_observation` and `type=critic_failure`** so the critic re-derives from primary data
   - Formats as a "GROUNDED CONTEXT" section
4. **`_store_critic_observation(observation, task)`**
   - **Critic v2: pre-storage cosine probe** against recent critic_observation entries (top-K probe, threshold `CRITIC_NOVELTY_COSINE_THRESHOLD`)
   - Suppresses + logs if similar to existing observation
   - Otherwise auto-stores as `memory_type=critic_observation`
5. **`_critic_call(task, user_input, timeout, project)`** — orchestration helper that grounds the input, calls the wrapper, stores the result via the novelty-filtered path
6. **Four `@mcp.tool()` functions** — `critic_review_round`, `critic_chorus_health`, `critic_memory_triage`, `critic_health` (first three delegate to `_critic_call`; `critic_health` is a direct llama-server probe)

The `imports` block at the top of `server.py` needs `timedelta` added:
```python
from datetime import datetime, timezone, timedelta
```

---

## Calibration findings

These are reproducible failure modes worth knowing about before relying on critic output. All observed during initial deployment of Ministral-3-8B-Reasoning Q8 and subsequent Critic v2 operations.

### 1. The model still hallucinates plausibly-formatted IDs even with grounding

Grounding via `_gather_grounded_context_for_critic` reduces fabrication of memory IDs because real ones are now visible in context. But the model still fabricates AMQ-format identifiers (e.g., `20260507T013028`) when AMQ context isn't included in grounding. Small models do not reliably follow complex steering instructions; they fill any unfilled "shape" in the input format.

**Mitigation in place:** the wrapper's `_find_hallucinated_ids` runs regex-based ID extraction on the model's observation, substring-matches each found ID against the full input (including grounded context), and populates a `hallucinated_ids` list + warning in the result dict when fabrication is detected.

**Future enhancement:** include AMQ context in grounding alongside memory context. Same scope policy applies.

### 2. Sparse user inputs cause confabulation

User inputs under ~100 tokens cause the model to fill gaps with plausible-but-invented context (e.g., inventing "regression suite" or "staging environment" details that weren't present in the round). The wrapper's grounded context helps but doesn't fully compensate. Sweet spot for `batch_review` tasks: 300-600 tokens of round content plus grounded context.

### 3. Reasoning model emits internal monologue

The default model (Ministral-3-8B-Reasoning) emits `[THINK]...[/THINK]` chain-of-thought before its actual answer. The wrapper strips these post-generation. If the entire response is `[THINK]` with no answer (model never reached the final answer within max_tokens), the wrapper returns `status=no_observation`.

### 4. Anthropic MCP proxy timeout

Critic calls exceeding ~200-300 seconds may fail at the Anthropic MCP proxy layer regardless of local timeout config. For grounded calls on slow hardware, reduce `CRITIC_MAX_MEMORIES` and `CRITIC_MEMORY_PREVIEW_CHARS` to keep total inference within window. For genuinely longer runs, implement a fire-and-forget pattern.

### 5. Self-referential grounding loop (Critic v2 — the load-bearing finding)

Across 5 weeks of pre-v2 deployment, the critic produced 53 observations of which 1 was genuinely useful (the convergence-without-data finding during the DSVP saga). Six near-identical "Instance 2 is sole dissenter" observations accumulated May 10–15, each citing prior ones as evidence. The "sole dissenter" framing was empirically false — saves were distributed across instances — but the critic kept restating it because its own prior observations were being fed back as grounded context.

**Root cause:** the wrapper's `_gather_grounded_context_for_critic` pulled all recent project memories without filtering OUT prior `critic_observation` entries. The critic was reading its own past conclusions as fact, then reinforcing them.

**Mitigation:** the three Critic v2 fixes documented above (grounding strip + novelty filter + demand-driven schedule). Verified empirically: grounded_chars dropped 53%, storage rate dropped 60% (suppressed re-derivations are logged but not persisted), novelty filter caught similarity probes at 0.794 / 0.807 / 0.852 in the post-fix audit.

**Watch for recurrence** if novelty threshold is lowered without re-calibrating against your own corpus, or if the grounding strip is weakened.

---

## Building your own model pipeline

The critic infrastructure is model-agnostic. Drop in any GGUF abliterated reasoning model:

1. **Source model:** any base reasoning model on HuggingFace
2. **Abliteration:** [Heretic](https://github.com/p-e-w/heretic) handles 7-13B models comfortably on a 12GB+ GPU. Heretic strips refusal directions from model weights via interpretability-guided ablation. See citations below.
3. **Conversion:** `python convert_hf_to_gguf.py <merged-model-dir> --outfile model.gguf --outtype bf16`
4. **Quantization:** `llama-quantize input.gguf output.gguf Q8_0` (Q4_K_M for tighter memory; Q8_0 for accuracy on >8B models)
5. **Deploy:** point `--model` in `persmem-critic.service` at the new GGUF, restart service

The pipeline scales to 70B-class models given enough RAM. For dual-Xeon servers with ≥96GB RAM, a 70B Q4_K_M abliterated model is comfortable async-batch territory at ~1 tok/s.

---

## Acknowledgments

This component depends on and acknowledges:

- **[Heretic](https://github.com/p-e-w/heretic)** by Philipp Emanuel Weidmann — fully automatic censorship removal for language models. The abliteration step in this pipeline uses Heretic. Citation:

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

- **[llama.cpp](https://github.com/ggml-org/llama.cpp)** by Georgi Gerganov and contributors — the inference engine for GGUF models. The critic runs on `llama-server` from this project.

- **[Ministral-3-8B-Reasoning-2512](https://huggingface.co/mistralai/Ministral-3-8B-Reasoning-2512)** by Mistral AI — the base model used for the default critic deployment.

- **[ChromaDB](https://github.com/chroma-core/chroma)** — vector database backing persMEM's memory storage.

- **[Voyage AI voyage-4-nano](https://huggingface.co/voyageai/voyage-4-nano)** — embedding model used by persMEM for semantic memory retrieval.

---

## License

Apache 2.0, same as persMEM+.
