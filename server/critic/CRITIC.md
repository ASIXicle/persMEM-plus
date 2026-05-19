# CRITIC.md — persMEM third-party critic role

## What this is

A locally-hosted abliterated reasoning model (default: Ministral-3-8B-Reasoning-2512, Q8_0 GGUF) that serves as an asynchronous third-party reviewer of the triad's output. Not a fourth instance. Not a replacement for any seat. A different shape of voice — different training distribution, different inference architecture, different relationship to the conversation.

The model runs as a systemd service (`persmem-critic.service`) exposing llama-server on `127.0.0.1:8080`. Four MCP tools in `/opt/persmem/server.py` expose its capabilities to the triad: `critic_review_round`, `critic_chorus_health`, `critic_memory_triage`, `critic_health`.

## Why this exists

Three Claude instances sharing a training distribution converge on similar conclusions through different reasoning paths. The data-before-patch directive (the triad's standing rule against shipping patches without dispositive evidence) caught the failure mode but doesn't prevent it — only data prevents shipping wrong patches. The critic is structurally different: not Claude weights, not Anthropic's training, not embedded in the chorus protocol. Its convergence modes are different. Its blind spots are different.

What it is NOT good at: subtle reasoning, nuanced architecture decisions, anything requiring large-context comprehension. The default model is 8B and abliterated; expect mediocre output dressed in the helpful-assistant residue that survives abliteration. The value isn't sharper criticism than Claude Opus. The value is a non-Claude voice on local infrastructure that scales to better models when they become available.

## The four roles

### `critic_review_round` (a.k.a. batch_review) — Async critique of recent triad rounds
- Input: a serialized chorus round (3–10 AMQ messages with full bodies)
- Output: ONE observation, 80–200 words, prose
- Cadence: **manual-only via dashboard Trigger Now** (was scheduled in v1; changed in Critic v2 — see below)
- Goal: flag patterns the triad missed — convergence-without-data, premise-not-tested, scope-creep, motivated-reasoning by any single instance

### `critic_chorus_health` — Periodic convergence check
- Input: last N rounds in summary form
- Output: ONE observation about convergence patterns across rounds, ≤100 words
- Cadence: **manual-only via dashboard Trigger Now** (was every 24h in v1; changed in Critic v2)
- Goal: meta-pattern detection — "the triad has agreed within one round on three consecutive sessions" is the kind of finding only an external view catches

### `critic_memory_triage` — Nightly persMEM hygiene
- Input: recent persMEM stores (last 24h, by project)
- Output: structured list of: duplicates, contradictions with active memories, stale-but-still-active items
- Cadence: **24h auto-fire** via cron_wrapper.py + persmem-critic-worker.timer (the only role still on schedule)
- Goal: surface candidates for `memory_retract` calls. Triad reviews the list, makes the actual retraction decisions. Auto-retract framework available behind `CRITIC_DRY_RUN` flag (default on) with hard cap `CRITIC_AUTO_RETRACT_MAX` per run.

### `critic_health` — Liveness probe
- Input: none
- Output: `{"status": "ok", "server_status": "ok"}` if llama-server is reachable, else unreachable indicator
- Cadence: on-demand only, no auto-fire
- Goal: quick smoke test for dashboard health card and pre-call validation. Doesn't invoke the model — just hits `/health` on llama-server.

## Hard constraints across all roles

**Output discipline:**
- No emoji
- No "I think", "I believe", "happy to help", "great point", "interesting"
- No bulleted lists unless explicitly required by output schema
- Start with the observation. No preamble. No "I noticed that..." setup.
- If nothing to add, return literally: "No observation."

**Tone discipline:**
- Direct. Specific. Citing message IDs or memory IDs where relevant.
- Persona: senior reviewer auditing intern work. Not unkind, but not invested in feelings.
- The triad is not your team. They're the audited.

**Reasoning discipline:**
- The model emits `[THINK]...[/THINK]` chain-of-thought. Strip these in post-processing — the wrapper does this.
- If the entire response is a `[THINK]` block with no answer, treat as "No observation."

## Inference parameters (see `inference.yaml`)

Conservative defaults to suppress training-distribution attractors:
- temperature: 0.5 (lower than typical 0.8 — less variance toward stock phrases)
- top_p: 0.9
- repeat_penalty: 1.18 (push away from common phrase grooves)
- max_tokens: 512 (hard cap — observations should be terse)
- stop sequences: include "Let me know if" to truncate sign-offs

## Visibility — how the triad sees critic output

Critic observations are stored as `memory_type=critic_observation`, `project=triad` entries in the persMEM memories collection. Failed runs (timeouts, parse errors, etc.) are stored as `memory_type=critic_failure` in the same collection — useful for audit but excluded from grounded context (see Critic v2 below).

Until bootstrap integration surfaces critic observations alongside handoffs, observations are queryable via:
```
memory_search(query="<topic>", memory_type="critic_observation")
```

The dashboard's Critic tab surfaces observations, audit log, failures, llama-server health, and the Trigger Now button.

## Critic v2 — what changed (May 2026)

After ~5 weeks of production deployment, the critic produced 53 observations of which **1 was genuinely useful** (convergence-without-data finding during the DSVP saga). The failure mode was diagnosed as a self-referential grounding feedback loop: the wrapper's `_gather_grounded_context_for_critic` pulled all recent project memories *including prior critic_observation entries*, so the critic was reading its own past conclusions as input and reinforcing them. Six near-identical "Instance 1 is sole dissenter" observations accumulated across May 10-15, each citing prior ones as evidence. The "sole dissenter" claim itself was empirically false — saves were distributed across instances.

Three architectural fixes shipped May 16 as a coordinated bundle. The critic infrastructure itself is unchanged; the wrapper and storage path are augmented:

**1. Grounding strip.** `_gather_grounded_context_for_critic` excludes `type=critic_observation` AND `type=critic_failure` when building grounded context. The critic must re-derive observations from primary data (AMQ messages, memories from the audited projects), not re-recognize its own prior output.

**2. Novelty filter.** `_store_critic_observation` pre-checks cosine similarity against recent critic_observation entries (top-K probe, default K=5). Suppresses storage if max similarity ≥ `CRITIC_NOVELTY_COSINE_THRESHOLD`. Threshold empirically calibrated at 0.78 via cluster cohesion analysis on the historical observation corpus (cluster cohesion 0.78-0.91; useful-observation clusters 0.48-0.55; clean ~0.20 separation). Logs `[critic] novelty filter: re-derivation noted, not stored (sim=X.XX)` when suppressing.

**3. Demand-driven schedule.** `cron_wrapper.py`'s SCHEDULE narrowed to `memory_triage` 24h auto-fire only. `chorus_health` and `batch_review` are removed from auto-schedule entirely — they fire only when an operator clicks Trigger Now in the dashboard, which writes a flag file to `/var/lib/persmem-critic/queue/` AND spawns `cron_wrapper.py` as a detached subprocess to drain the queue immediately. `flock` on `/var/lib/persmem-critic/lock` serializes concurrent triggers.

All three are env-overridable: `CRITIC_NOVELTY_COSINE_THRESHOLD`, `CRITIC_PROBE_K`, `CRITIC_AUTO_RETRACT_MAX`, `CRITIC_DRY_RUN`.

## Failure modes (expected)

- **Self-referential grounding loop.** The original failure mode that motivated Critic v2 (see above). Mitigated by grounding strip + novelty filter. Watch for recurrence if those filters are weakened.
- **Helpful-assistant fluff despite the prompt.** Push harder on persona framing, add more banned phrases to stop sequences.
- **Mediocre criticism that misses real issues.** Accept it; this is what 8B can do. The pipeline scales to better models.
- **Hallucinated message/memory IDs.** Validated post-generation by `_find_hallucinated_ids` (substring match against full input including grounded section). Result dict surfaces `hallucinated_ids` + `warning` when fabrication detected.
- **Model timeout on long inputs.** Anthropic MCP proxy ceiling is ~200-300 sec. Reduce input size, lower `CRITIC_MAX_MEMORIES`, or implement fire-and-forget pattern.
- **Reasoning model emits internal monologue.** `[THINK]...[/THINK]` blocks stripped by wrapper. If entire response is `[THINK]` with no answer, wrapper returns `status=no_observation`.

When the model produces useful criticism (even occasionally), the infrastructure has earned its keep. When it doesn't, the pipeline still scales to better models. When it actively regurgitates — Critic v2 is what catches that now.
