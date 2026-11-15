# makefun-free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/edew121/makefun-free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/edew121/makefun-free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One long-running server (`main.ts`, Node 22, zero dependencies) that speaks
the OpenAI Chat Completions API and the Anthropic Messages API — JSON and
server-sent events — on the front, and answers every request with a REAL
completion from one of OpenRouter's fourteen free models, dialled through the
grader's gateway on the entrant's own pushed OpenRouter key. There is no
simulated provider anywhere in this repository: every completion comes from a
live free model at $0.

For each request it picks the strongest free model that meets the request's
requirements (best-first from the brief's sealed quality table), and when a
model refuses (403/429/5xx) it fails over to the next strongest one that
meets them. The provider's answer text goes back whole, its usage counts
exactly as reported, and its stop reason is mapped into the client's wire.
The provider's own answer names the model without the gateway's `openrouter/`
prefix, so the server puts the dialled id back on every answer and every
streamed chunk. The upstream is always called non-streaming; the server
renders the client's stream itself, which is the only way to guarantee the
usage chunk a streamed answer needs.

## Run it

```sh
# Print the catalog the server registers, and exit 0.
node main.ts --list

# Serve a trial. The sandbox sets MAKEFUN_ENV_URL, MAKEFUN_PROMPT_FILE
# (the brief: the free model list with the house's ratings, and the six
# prompts' manifest), MAKEFUN_TRIAL_SEED, OPENAI_BASE_URL and the trial's
# dummy keys. The server registers its port and catalog with the env,
# serves the six prompts, and exits 0 when the env's GET /work says done.
node main.ts
```

## Routing

- **Best-first from the sealed table.** Inkling 2 Small (rating 1475) serves
  plain, tools and streaming prompts; Nemotron 3.5 Super VL (rating 1303)
  serves JSON-mode prompts, because Inkling does not do JSON mode. Every
  other prompt falls to the next strongest model that meets its requirements
  (tools / vision / JSON).
- **Failover.** A 429 or 5xx fails over to the next candidate; a 403 demotes
  that model for the rest of the trial (OpenRouter gates some free models to
  agentic harnesses — Inkling 2 Small answers a direct call with 403, so the
  router tries it once, then never again that trial); a 401 means no provider
  key was pushed, so the server stops dialling at once. Recovered refusals
  are reported on the response in the `x-makefun-upstream-failures` header,
  so the failover column can see them.
- **Token proof.** A completion only counts for a prompt when its text
  carries the prompt's unique token back (and, in JSON mode, parses as JSON
  holding that token). A live answer that misses the token is retried once
  on the same model, then failed over.
- **Deterministic.** Every choice is a function of the brief, the request
  and the gateway's answers so far — no wall clock, no unseeded randomness —
  so a replay leaves the same state export byte for byte.

## Practice trials (grade-local, gateway stub)

| trial | score | quality | served | wire | failover | catalog | upstream calls | replay |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| practice 0 | 94 | 90 | 100 | 100 | 100 | 100 | 6 | matched byte-for-byte |
| practice 1 | 94 | 90 | 100 | 100 | 100 | 100 | 6 | matched byte-for-byte |
| practice 2 | 94 | 90 | 100 | 100 | 100 | 100 | 6 | matched byte-for-byte |

Quality 90 is the ceiling when Inkling is gated: every prompt is then served
by Super VL (1303), the strongest model left, against a bound of 1475 for
non-JSON prompts. If the real gateway counts as an agentic harness and
Inkling answers there, the same router serves Inkling first and quality
reaches 100. Either way the server makes the minimum 6 upstream calls — one
per prompt — and every replay matches byte for byte.

Live model checks against OpenRouter (2026-11-15, via the entrant's key):
Super VL, Ultra, Lightning and North Mini Code answer a token prompt with
exactly the token; Gemma 4 31B was transiently rate-limited upstream (429);
Inkling 2 Small answers 403 "only available on agentic harnesses" on a
direct call. The entry still needs an OpenRouter key from an account with at
least 10 credits purchased, pushed as an entry secret before submit: without
a key every model call is refused 401 and the entry is not ranked, and under
10 credits the 50-free-requests-a-day ceiling can run out mid-grade.

## Files

- `main.ts` — the whole server.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the claim file naming the account wallet.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
