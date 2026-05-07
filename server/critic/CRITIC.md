# CRITIC.md — persMEM third-party critic role

## What this is

A locally-hosted abliterated reasoning model (Ministral-3-8B-Reasoning-2512, Q8_0 GGUF) that serves as an asynchronous third-party reviewer of the triad's output. Not a fourth instance. Not a replacement for any seat. A different shape of voice — different training distribution, different inference architecture, different relationship to the conversation.

The model runs as a systemd service (`persmem-critic.service`) exposing llama-server on `127.0.0.1:8080`. Three MCP tools in `/opt/persmem/server.py` expose its capabilities to the triad: `critic_review_round`, `critic_chorus_health`, `critic_memory_triage`.

## Why this exists

Three Claude instances sharing a training distribution converge on similar conclusions through different reasoning paths. The data-before-patch directive (mem-9083367e98cd7fd6) caught the failure mode but doesn't prevent it — only data prevents shipping wrong patches. The critic is structurally different: not Claude weights, not Anthropic's training, not embedded in the chorus protocol. Its convergence modes are different. Its blind spots are different.

What it is NOT good at: subtle reasoning, nuanced architecture decisions, anything requiring large-context comprehension. The model is 8B and abliterated; expect mediocre output dressed in the helpful-assistant residue that survives abliteration. The value isn't sharper criticism than Claude Opus. The value is a non-Claude voice on local infrastructure that scales to better models when they become available.

## The three roles

### `batch_review` — Async critique of recent triad rounds
- Input: a serialized chorus round (3–10 AMQ messages with full bodies)
- Output: ONE observation, 80–200 words, prose
- Cadence: every 12 hours, or on demand
- Goal: flag patterns the triad missed — convergence-without-data, premise-not-tested, scope-creep, motivated-reasoning by any single instance

### `chorus_health` — Periodic convergence check
- Input: last N rounds in summary form
- Output: ONE observation about convergence patterns across rounds, ≤100 words
- Cadence: every 24 hours
- Goal: meta-pattern detection — "the triad has agreed within one round on three consecutive sessions" is the kind of finding only an external view catches

### `memory_triage` — Nightly persMEM hygiene
- Input: recent persMEM stores (last 24h, by project)
- Output: structured list of: duplicates, contradictions with active memories, stale-but-still-active items
- Cadence: nightly
- Goal: surface candidates for `memory_retract` calls. Triad reviews the list, makes the actual retraction decisions.

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

Critic observations are stored as `memory_type=critic_observation`, `project=triad` entries in the persMEM memories collection. The bootstrap layer (chorus_init) should pull recent unread critic observations alongside its other handoff material — see architecture-hack #2 in the persMEM hacks document.

Until that bootstrap integration ships, observations are queryable via `memory_search(query="critic observation", memory_type="critic_observation")`.

## Tuning expectations

Initial deployment is calibrated for "produce something useful, expect mediocre quality." Iterate on:
- The three task prompts (in `prompts/`)
- The inference parameters
- The stop sequences (when the model emits a stock phrase, add it to stop)

The prompts are the primary tuning surface. Re-run the model against historical triad rounds (we have plenty in persMEM) to validate output quality before deployment as a service.

## Failure modes (expected)

- Model produces helpful-assistant fluff despite the prompt — push harder on persona framing, add more banned phrases
- Model produces mediocre criticism that misses real issues — accept it; this is what 8B can do
- Model timeout on long inputs — chunk the input, run multiple invocations
- Model produces hallucinated message IDs — validate IDs against persMEM before storing observations

When the model produces useful criticism (even occasionally), the infrastructure has earned its keep. When it doesn't, the pipeline still scales to better models.
