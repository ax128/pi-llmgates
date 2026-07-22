# Pi LLMGates Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@llmgates_api/pi-llmgates-provider` so pi users can `/login LLMGates`, list models from the gateway, run inference, and check balance.

**Architecture:** TypeScript pi extension package. `index.ts` registers OAuth-style provider + dynamic models from `GET /v1/models?client_version=pi`. `lib.ts` handles URL normalization and model mapping. `balance.ts` adds `/balance` via existing `GET /v1/user/balance`. No custom stream patch — pi built-in APIs only.

**Tech Stack:** Node 22+, TypeScript, vitest, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`

**Spec:** `docs/superpowers/specs/2026-07-22-pi-llmgates-provider-design.md`

**Backend:** TokenX [#1080](https://github.com/ax128/TokenX/issues/1080) (pi enriched catalog — Phase 2, non-blocking)

---

## File map

| File | Responsibility |
|------|----------------|
| `extensions/index.ts` | Provider registration, `/login LLMGates`, startup model refresh |
| `extensions/lib.ts` | Config I/O, endpoints, model mapping, HTTP clients |
| `extensions/balance.ts` | `/balance` command |
| `extensions/lib.test.ts` | Unit tests |
| `package.json` | pi manifest + npm metadata |
| `README.md` | User-facing install/login docs |

---

### Task 1: Core provider (done)

**Files:**
- Create: `extensions/index.ts`, `extensions/lib.ts`
- Test: `extensions/lib.test.ts`

- [x] baseUrl normalization (`apicn.llmgates.com` → `https://apicn.llmgates.com/v1`)
- [x] OAuth-only `/login` with models validation
- [x] Map `web_chat_endpoint` → pi `api` per model
- [x] Phase 1 reasoning heuristics + Phase 2 `supported_reasoning_levels` passthrough
- [x] Config: `~/.pi/agent/llmgates.json` + `LLMGATES_*` env

---

### Task 2: Balance command (done)

**Files:**
- Create: `extensions/balance.ts`
- Modify: `extensions/lib.ts`, `extensions/index.ts`, `package.json`

- [x] `GET /v1/user/balance` client
- [x] `/balance` command with formatted wallet/bonus/subscription
- [x] Unit tests for URL + message formatting

---

### Task 3: Docs & packaging (done)

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-07-22-pi-llmgates-provider-design.md`

- [x] Design spec
- [x] README install/login/env
- [x] LICENSE, `.gitignore`, `vitest.config.ts`

---

### Task 4: Manual integration test

**Requires:** valid `sk-llmgates-*` key

- [ ] `pi install /path/to/pi_llmgates`
- [ ] `/login LLMGates` → models listed in `/model`
- [ ] Run short prompt on `responses` model (e.g. gpt-5.x)
- [ ] Run short prompt on `messages` model (e.g. claude-*)
- [ ] `/balance` shows non-error balance

---

### Task 5: Phase 2 — backend catalog alignment

**Blocked on:** TokenX #1080 merged

- [ ] Verify `supported_reasoning_levels` from gateway overrides heuristics
- [ ] Add `/fast` if `service_tiers` exposed (optional, mirror cliproxyapi)
- [ ] Pin integration test against `?client_version=pi` response shape

---

### Task 6: Publish

- [ ] Confirm npm scope `@llmgates` ownership
- [ ] `npm publish --access public`
- [ ] Document `pi install npm:@llmgates_api/pi-llmgates-provider` on pi.dev

---

## Verification

```bash
npm run check   # tsc + vitest
```

Expected: all tests pass, no type errors.
