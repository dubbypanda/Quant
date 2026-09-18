# Quant release notes

## 2.2.0 — Correctness and Public Repository Hardening

Quant v2.2.0 is a focused reliability release. It strengthens the public terminal's existing claims without importing the experimental QuantDesktop/3.0 feature set.

### Highlights:
- **Correct breakout structure:** Breakout and failed-breakout levels are derived from prior closed bars, eliminating self-referential resistance.
- **Live-only scanner rankings:** Synthetic sample candles can keep charts usable offline but can no longer appear as ranked market candidates.
- **Truthful universe scope:** The scanner is labeled **Curated U.S.** and reports attempted, successfully scanned, and unavailable coverage.
- **Forward-record correctness:** Pruning keeps the newest resolved outcomes and summary timestamps remain chronological after pruning/reloads.
- **Regression coverage:** Signal V2 explicitly tests breakout structure plus forward-record ordering/pruning invariants.
- **One-command verification:** `npm run verify` runs the deterministic local typecheck, core tests, Signal V2 tests, and production build.
- **Repository hygiene:** Generated `dist/` output is no longer tracked, and Kronos implementation documents now live under `docs/forecast/`.

## 2.1.0 — Quant Signal Engine V2, Signal Board Candidate Filters, and New App Logo

Quant v2.1.0 is a major engine release introducing **Quant Signal Engine V2**, dedicated **Signal Board candidate filtering**, and a new branding design.

### Highlights:
- **Signal Board Candidate Filters:** Directly filter the scanned universe for `🟢 Buy Candidates` and `🔴 Short Candidates` with live Setup Quality scores (`quality 82/100`), candidate badges, and active count summary meters.
- **Authoritative 1D Signal Desk:** Pure 1D daily price structure evaluation decoupled from visual chart zoom/range. Honest decision classification (`BUY CANDIDATE`, `SHORT CANDIDATE`, `WAIT`, `NO TRADE`, `INVALIDATED`) with explicit blocker breakdowns.
- **Setup-Specific Causal Historical Replay:** Lookahead-free 5-year daily replay modeling next-open entries, 5 bps slippage, pre-entry gap invalidations, same-bar stop priorities, and 10-bar timeout exits.
- **Statistical Confidence Intervals:** Deterministic `mulberry32` PRNG bootstrap 95% CI on expectancy $R$ and 95% Wilson score intervals on win rate.
- **Forward Outcome Store:** Persistent forward candidate tracker (`quant-signal-outcomes-v1.json`) automatically resolving outcomes against subsequent daily prints.
- **New App Logo & Branding:** Integrated the new Quant blue fox logo across window titlebars, Electron runtime icons, HTML favicons, and the top-left terminal header.

## 2.0.1 — LLM connection-test and calendar fixes

The LLM Settings connection test no longer truncates at eight tokens. OpenAI reasoning models can consume that entire budget before emitting visible text, and local Ollama/OpenAI-compatible endpoints can truncate the probe. The shared connection-test budget is now 128 tokens for both endpoint families.

Validation: the full release gate passed TypeScript, Quant integration, fast UI resilience, one-command startup, all 44 Python tests, forecast packaging, native ARM64 sidecar health, production build, and the built renderer harness.
