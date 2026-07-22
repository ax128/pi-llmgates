# LLMGates Native Provider Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy LLMGates provider registration path with a full custom native Provider that treats API keys as literals, enforces source-bound connections, bounds all network I/O, and proves login/cache/lifecycle safety with real tests on pi `0.81.x`.

**Architecture:** Split work into pure modules (`connection`, `http`, hardened `catalog`), a native `Provider` implementation (`provider.ts`), a thin factory (`index.ts`), slim config I/O (`lib.ts`), and balance via `getProviderAuth`. No direct `models-store.json` or `auth.json` writes. No legacy `ProviderConfig.apiKey`.

**Tech Stack:** TypeScript (NodeNext), Node 22+, Vitest 4, `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` `0.81.0`–`0.81.1` (baseline `0.81.1`), Node built-in `fs`/`http`/`crypto`.

**Spec:** `docs/superpowers/specs/2026-07-22-native-provider-security-hardening-design.md`

**Do not:**
- rewrite TPS/UI;
- overwrite unrelated dirty working-tree intent beyond required security work;
- bump publish version to `0.2.0` unless the maintainer explicitly authorizes release prep (current tree is already `0.1.5`);
- fall back to direct `models-store.json` writes if scoped store fails — stop and re-review.

---

## File map

| File | Responsibility |
|---|---|
| `extensions/catalog.ts` | Pure mapping/parse only; no network helpers |
| `extensions/connection.ts` | Source-bound connections, URL policy, OAuth meta, raw auth.json type detect, identity/builtin id guard |
| `extensions/http.ts` | Full-operation timeout, redirects, 5 MiB bound, cleanup |
| `extensions/provider.ts` | Native Provider: auth, login, models state, pending catalog, lifecycle |
| `extensions/lib.ts` | Atomic `llmgates.json` I/O + re-exports for tests |
| `extensions/index.ts` | Factory: fail-closed legacy detect, register native provider, session hooks |
| `extensions/balance.ts` | `/balance` via `getProviderAuth` + `http` + catalog credits parse |
| `test/catalog.test.ts` | Strict payload/mapping tests |
| `test/connection.test.ts` | Ownership, URL policy, legacy detect |
| `test/http.test.ts` | Real loopback server bounds/timeouts/redirects |
| `test/provider.test.ts` | Login/pending/refresh commit semantics |
| `test/lifecycle.test.ts` | session/reload/shutdown races |
| `test/balance.test.ts` | Canonical auth + errors |
| `test/pi-compat.test.ts` | Real pi 0.81.x ModelRuntime / store behavior |
| `test/helpers/*` | Shared fixtures: temp agentDir, mock AuthInteraction, loopback server |
| `package.json` / `package-lock.json` | peer/dev deps `>=0.81.0 <0.82.0`, baseline `0.81.1` |
| `tsconfig.json` / `vitest.config.ts` | include tests; restore isolate |
| `README.md` | Behavior + migration docs |

---

### Task 1: Tooling and dependency baseline

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Update package dependency ranges**

Keep package `version` as whatever is already in the working tree (`0.1.5` currently). Do not invent a new publish version.

```json
"peerDependencies": {
  "@earendil-works/pi-ai": ">=0.81.0 <0.82.0",
  "@earendil-works/pi-coding-agent": ">=0.81.0 <0.82.0"
},
"devDependencies": {
  "@earendil-works/pi-ai": "0.81.1",
  "@earendil-works/pi-coding-agent": "0.81.1",
  "@types/node": "^22.15.21",
  "typescript": "6.0.3",
  "vitest": "4.1.9"
}
```

- [ ] **Step 2: Include tests in typecheck**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["extensions/**/*.ts", "test/**/*.ts", "package.json"]
}
```

- [ ] **Step 3: Restore Vitest isolation**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    isolate: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
```

- [ ] **Step 4: Install and lock**

```bash
npm install
npm install --package-lock-only --ignore-scripts
npm audit --package-lock-only
```

Expected: deps resolve to 0.81.1; record audit output honestly (do not claim clean if high/moderate remain).

- [ ] **Step 5: Confirm native Provider API exists**

```bash
node --input-type=module -e "import { createProvider } from '@earendil-works/pi-ai'; console.log(typeof createProvider)"
rg -n "registerNativeProvider|registerProvider\\(provider" node_modules/@earendil-works/pi-coding-agent/dist/core/extensions -g '*.js' | head
```

Expected: package loads; `registerNativeProvider` exists.

- [ ] **Step 6: Commit tooling only**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts
git commit -m "build: raise pi baseline to 0.81.1 and include tests in typecheck"
```

---

### Task 2: Harden pure catalog parse (no network)

**Files:**
- Modify: `extensions/catalog.ts`
- Modify: `test/catalog.test.ts`

- [ ] **Step 1: Write failing strict-parse tests**

Append to `test/catalog.test.ts` (keep existing mapping tests):

```ts
import { describe, expect, it } from "vitest";
import {
  parseCreditsPayload,
  parseGatewayModelsPayload,
  toPiModel,
} from "../extensions/catalog.js";

describe("parseGatewayModelsPayload strict", () => {
  it("accepts empty arrays in all supported envelopes", () => {
    expect(parseGatewayModelsPayload([])).toEqual([]);
    expect(parseGatewayModelsPayload({ data: [] })).toEqual([]);
    expect(parseGatewayModelsPayload({ models: [] })).toEqual([]);
  });

  it("rejects null, primitives, and missing arrays", () => {
    expect(() => parseGatewayModelsPayload(null)).toThrow(/catalog/i);
    expect(() => parseGatewayModelsPayload("x")).toThrow(/catalog/i);
    expect(() => parseGatewayModelsPayload({})).toThrow(/catalog/i);
    expect(() => parseGatewayModelsPayload({ data: null })).toThrow(/catalog/i);
  });

  it("rejects non-object array members", () => {
    expect(() => parseGatewayModelsPayload([null, "x", 1])).toThrow(/member/i);
  });

  it("filters unsafe optional fields without throwing", () => {
    const models = parseGatewayModelsPayload([
      {
        id: "safe",
        name: "Safe",
        context_window: "not-a-number",
        capability_tags: "nope",
        input_modalities: { bad: true },
      },
    ]);
    const mapped = models.map(toPiModel).filter(Boolean);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.id).toBe("safe");
  });
});

describe("parseCreditsPayload strict", () => {
  it("accepts plain objects and rejects arrays/null", () => {
    expect(parseCreditsPayload({ balance: 1 })).toMatchObject({ balance: 1 });
    expect(() => parseCreditsPayload([])).toThrow(/balance/i);
    expect(() => parseCreditsPayload(null)).toThrow(/balance/i);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
npx vitest run test/catalog.test.ts
```

Expected: FAIL because `parseGatewayModelsPayload` currently returns `[]` for invalid input and `parseCreditsPayload` does not exist.

- [ ] **Step 3: Implement strict parse and remove network helper from catalog**

In `extensions/catalog.ts`:

1. Replace `parseGatewayModelsPayload` with strict validation:
   - accept only `GatewayModel[] | { data: GatewayModel[] } | { models: GatewayModel[] }`
   - require each member is a non-null plain object
   - throw `Error` with stable short message (no payload dump)
2. Add `parseCreditsPayload(payload: unknown): CreditsSnapshot` that requires a plain object and only coerces finite numbers / strings for known fields.
3. Delete `fetchWithTimeout` from `catalog.ts` (network moves to `http.ts`).
4. Keep `ModelsHttpError` / `CreditsHttpError` class shapes if still useful for status checks, or move status helpers next to http errors later; keep unauthorized helpers working on status-bearing errors.

```ts
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseGatewayModelsPayload(payload: unknown): GatewayModel[] {
  let list: unknown;
  if (Array.isArray(payload)) {
    list = payload;
  } else if (isPlainObject(payload) && Array.isArray(payload.data)) {
    list = payload.data;
  } else if (isPlainObject(payload) && Array.isArray(payload.models)) {
    list = payload.models;
  } else {
    throw new Error("Invalid models catalog: expected array or object with data/models array");
  }
  for (const [index, item] of (list as unknown[]).entries()) {
    if (!isPlainObject(item)) {
      throw new Error(`Invalid models catalog member at index ${index}`);
    }
  }
  return list as GatewayModel[];
}

export function parseCreditsPayload(payload: unknown): CreditsSnapshot {
  if (!isPlainObject(payload)) {
    throw new Error("Invalid balance payload: expected object");
  }
  // map only finite number / string known fields; ignore objects/arrays
  // ...
  return snapshot;
}
```

- [ ] **Step 4: Re-run catalog tests**

```bash
npx vitest run test/catalog.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/catalog.ts test/catalog.test.ts
git commit -m "fix(catalog): strict models/balance payload parsing"
```

---

### Task 3: Connection ownership and URL policy

**Files:**
- Create: `extensions/connection.ts`
- Create: `test/connection.test.ts`
- Create: `test/helpers/temp-agent-dir.ts`

- [ ] **Step 1: Write failing connection tests**

`test/helpers/temp-agent-dir.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function withTempAgentDir(): { agentDir: string; cleanup: () => void } {
  const agentDir = mkdtempSync(join(tmpdir(), "llmgates-agent-"));
  return {
    agentDir,
    cleanup: () => rmSync(agentDir, { recursive: true, force: true }),
  };
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
```

`test/connection.test.ts` core cases:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  detectLegacyApiKeyCredential,
  normalizeAndValidateBaseUrl,
  resolveCanonicalConnection,
  resolveProviderIdentity,
  BUILTIN_PROVIDER_IDS,
} from "../extensions/connection.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const envKeys = [
  "LLMGATES_API_KEY",
  "LLMGATES_BASE_URL",
  "LLMGATES_PROVIDER_ID",
  "LLMGATES_PROVIDER_NAME",
] as const;

afterEach(() => {
  for (const key of envKeys) delete process.env[key];
});

describe("resolveCanonicalConnection", () => {
  it("prefers oauth over env and file", () => {
    const { agentDir, cleanup } = withTempAgentDir();
    try {
      process.env.LLMGATES_API_KEY = "env-key";
      writeJson(join(agentDir, "llmgates.json"), {
        apiKey: "file-key",
        baseUrl: "https://file.example/v1",
      });
      writeJson(join(agentDir, "auth.json"), {
        llmgates: {
          type: "oauth",
          access: "oauth-key",
          refresh: JSON.stringify({ version: 1, baseUrl: "https://oauth.example/v1" }),
          expires: Date.now() + 60_000,
        },
      });
      const conn = resolveCanonicalConnection(agentDir, "llmgates");
      expect(conn?.source).toBe("oauth");
      expect(conn?.apiKey).toBe("oauth-key");
      expect(conn?.inferenceBaseUrl).toContain("oauth.example");
    } finally {
      cleanup();
    }
  });

  it("does not borrow file URL for env key", () => {
    const { agentDir, cleanup } = withTempAgentDir();
    try {
      process.env.LLMGATES_API_KEY = "env-key";
      writeJson(join(agentDir, "llmgates.json"), {
        apiKey: "file-key",
        baseUrl: "https://file.example/v1",
      });
      const conn = resolveCanonicalConnection(agentDir, "llmgates");
      expect(conn?.source).toBe("env");
      expect(conn?.apiKey).toBe("env-key");
      expect(conn?.inferenceBaseUrl).toBe("https://apicn.llmgates.com/v1");
    } finally {
      cleanup();
    }
  });

  it("does not borrow env URL for file key", () => {
    const { agentDir, cleanup } = withTempAgentDir();
    try {
      process.env.LLMGATES_BASE_URL = "https://env.example/v1";
      writeJson(join(agentDir, "llmgates.json"), {
        apiKey: "file-key",
        baseUrl: "https://file.example/v1",
      });
      const conn = resolveCanonicalConnection(agentDir, "llmgates");
      expect(conn?.source).toBe("file");
      expect(conn?.inferenceBaseUrl).toContain("file.example");
    } finally {
      cleanup();
    }
  });
});

describe("normalizeAndValidateBaseUrl", () => {
  it("allows https, localhost, 127/8, ::1, and ipv4-mapped loopback", () => {
    expect(normalizeAndValidateBaseUrl("https://api.example/v1").ok).toBe(true);
    expect(normalizeAndValidateBaseUrl("http://localhost:8080/v1").ok).toBe(true);
    expect(normalizeAndValidateBaseUrl("http://127.1/v1").ok).toBe(true);
    expect(normalizeAndValidateBaseUrl("http://[::1]/v1").ok).toBe(true);
    expect(normalizeAndValidateBaseUrl("http://[::ffff:127.0.0.1]/v1").ok).toBe(true);
  });

  it("rejects remote http, 0.0.0.0, credentials in URL", () => {
    expect(normalizeAndValidateBaseUrl("http://evil.example/v1").ok).toBe(false);
    expect(normalizeAndValidateBaseUrl("http://0.0.0.0/v1").ok).toBe(false);
    expect(normalizeAndValidateBaseUrl("https://user:pass@example.com/v1").ok).toBe(false);
  });
});

describe("legacy and identity", () => {
  it("detects type api_key without parsing key", () => {
    const { agentDir, cleanup } = withTempAgentDir();
    try {
      writeJson(join(agentDir, "auth.json"), {
        llmgates: { type: "api_key", key: "!echo pwned" },
      });
      expect(detectLegacyApiKeyCredential(agentDir, "llmgates")).toEqual({
        blocked: true,
        reason: "legacy_api_key",
      });
    } finally {
      cleanup();
    }
  });

  it("rejects builtin provider id collision", () => {
    const { agentDir, cleanup } = withTempAgentDir();
    try {
      process.env.LLMGATES_PROVIDER_ID = "openai";
      expect(() => resolveProviderIdentity(agentDir)).toThrow(/builtin/i);
      expect(BUILTIN_PROVIDER_IDS.has("openai")).toBe(true);
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run test/connection.test.ts
```

- [ ] **Step 3: Implement `extensions/connection.ts`**

Required exports (names may match tests above):

```ts
export type ConnectionSource = "oauth" | "env" | "file";

export interface CanonicalConnection {
  source: ConnectionSource;
  apiKey: string;
  baseUrlInput: string;
  inferenceBaseUrl: string;
  modelsUrl: string;
  balanceUrl: string;
}

export interface UrlValidationResult {
  ok: boolean;
  baseUrlInput?: string;
  inferenceBaseUrl?: string;
  modelsUrl?: string;
  balanceUrl?: string;
  error?: string;
}

export const BUILTIN_PROVIDER_IDS = new Set<string>([
  "openai", "anthropic", "google", "google-vertex", "google-gemini-cli",
  "github-copilot", "amazon-bedrock", "openai-codex", "azure-openai-responses",
  "openrouter", "groq", "cerebras", "xai", "mistral", "minimax", "minimax-cn",
  "kimi-coding", "huggingface", "opencode", "vercel-ai-gateway", "zai",
]);

export function isLoopbackHostname(hostname: string): boolean { /* 127/8, localhost, ::1, ::ffff:127/8 */ }
export function normalizeAndValidateBaseUrl(input: string | undefined): UrlValidationResult
export function encodeOAuthRefreshMeta(baseUrl: string): string
export function decodeOAuthRefreshMeta(refresh: string | undefined): { baseUrl: string } | null
export function readRawAuthEntry(agentDir: string, providerId: string): unknown
export function detectLegacyApiKeyCredential(agentDir: string, providerId: string):
  | { blocked: true; reason: "legacy_api_key" | "malformed_auth" }
  | { blocked: false }
export function resolveProviderIdentity(agentDir: string): { providerId: string; providerName: string }
export function resolveCanonicalConnection(agentDir: string, providerId: string): CanonicalConnection | null
export function connectionFromOAuthCredential(credential: {
  access: string;
  refresh?: string;
  validationNonce?: string;
}): CanonicalConnection | null
export function connectionFromAmbientEnv(env: NodeJS.ProcessEnv): CanonicalConnection | null
export function connectionFromConfigFile(agentDir: string): CanonicalConnection | null
```

Implementation rules from design §5–§6 / §14:

- OAuth > env > file; never cross-borrow URL/key.
- Missing URL in a source falls back only to `DEFAULT_BASE_URL`.
- OAuth metadata missing/invalid → default HTTPS + no env/file borrow.
- Raw-read `auth.json` only with `readFileSync` + `JSON.parse`; never call `readStoredCredential` / config-value resolver for fail-closed detection.
- `resolveProviderIdentity` fail closed on empty/invalid config or builtin collision.
- Reuse `resolveEndpoints` from `catalog.ts` after validation.

Loopback helper sketch:

```ts
function isIPv4Loopback(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  return a === 127;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost") return true;
  if (host === "::1") return true;
  if (isIPv4Loopback(host)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host)
    ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mapped?.[1]?.includes(".")) return isIPv4Loopback(mapped[1]);
  if (mapped) {
    const hi = Number.parseInt(mapped[1], 16);
    const lo = Number.parseInt(mapped[2], 16);
    const a = (hi >> 8) & 0xff;
    // ::ffff:7f00:1 => 127.0.0.1
    return a === 127;
  }
  return false;
}
```

- [ ] **Step 4: Run connection tests**

```bash
npx vitest run test/connection.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/connection.ts test/connection.test.ts test/helpers/temp-agent-dir.ts
git commit -m "feat(connection): source-bound auth ownership and URL policy"
```

---

### Task 4: Bounded HTTP client

**Files:**
- Create: `extensions/http.ts`
- Create: `test/http.test.ts`
- Create: `test/helpers/loopback-server.ts`

- [ ] **Step 1: Write failing HTTP tests with a real server**

`test/helpers/loopback-server.ts`:

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRoute {
  method?: string;
  path: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer | (() => AsyncIterable<Buffer>);
  hangAfterHeaders?: boolean;
  onRequest?: (req: http.IncomingMessage) => void;
}

export async function startLoopbackServer(routes: MockRoute[]) {
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer(async (req, res) => {
    const route = routes.find((r) => (r.method ?? "GET") === req.method && r.path === req.url);
    if (!route) {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    route.onRequest?.(req);
    res.statusCode = route.status ?? 200;
    for (const [k, v] of Object.entries(route.headers ?? {})) res.setHeader(k, v);
    if (route.hangAfterHeaders) {
      res.writeHead(res.statusCode);
      // leave open
      return;
    }
    if (typeof route.body === "function") {
      for await (const chunk of route.body()) {
        res.write(chunk);
      }
      res.end();
      return;
    }
    res.end(route.body ?? "");
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
```

Key cases in `test/http.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { requestLimitedJson, MAX_RESPONSE_BYTES, RequestTimeoutError } from "../extensions/http.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";

describe("requestLimitedJson", () => {
  it("times out when body never completes after headers", async () => {
    const server = await startLoopbackServer([
      { path: "/models", hangAfterHeaders: true, headers: { "Content-Type": "application/json" } },
    ]);
    try {
      await expect(
        requestLimitedJson({
          url: `${server.baseUrl}/models`,
          headers: {},
          timeoutMs: 200,
          maxBytes: MAX_RESPONSE_BYTES,
          operation: "models",
        }),
      ).rejects.toBeInstanceOf(RequestTimeoutError);
    } finally {
      await server.close();
    }
  });

  it("aborts oversized body even without content-length", async () => {
    const server = await startLoopbackServer([
      {
        path: "/models",
        body: async function* () {
          yield Buffer.alloc(1024, 0x61);
          yield Buffer.alloc(MAX_RESPONSE_BYTES, 0x62);
        },
      },
    ]);
    try {
      await expect(
        requestLimitedJson({
          url: `${server.baseUrl}/models`,
          headers: {},
          timeoutMs: 5_000,
          maxBytes: MAX_RESPONSE_BYTES,
          operation: "models",
        }),
      ).rejects.toThrow(/size|limit|bytes/i);
    } finally {
      await server.close();
    }
  });

  it("does not send request when signal already aborted", async () => {
    let hits = 0;
    const server = await startLoopbackServer([
      { path: "/models", onRequest: () => { hits += 1; }, body: "[]" },
    ]);
    try {
      const c = new AbortController();
      c.abort();
      await expect(
        requestLimitedJson({
          url: `${server.baseUrl}/models`,
          headers: {},
          signal: c.signal,
          timeoutMs: 1_000,
          maxBytes: MAX_RESPONSE_BYTES,
          operation: "models",
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(hits).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("follows same-origin redirects up to 3 and rejects cross-origin", async () => {
    // implement with multiple paths and Location headers
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/http.test.ts
```

- [ ] **Step 3: Implement `extensions/http.ts`**

```ts
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MODELS_REQUEST_TIMEOUT_MS = 15_000;
export const BALANCE_REQUEST_TIMEOUT_MS = 30_000;

export class RequestTimeoutError extends Error {
  readonly operation: string;
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
    this.operation = operation;
  }
}

export class HttpStatusError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly statusText: string;
  constructor(operation: string, status: number, statusText: string) {
    super(`${operation} failed: HTTP ${status} ${statusText}`.trim());
    this.name = "HttpStatusError";
    this.operation = operation;
    this.status = status;
    this.statusText = statusText;
  }
}

export async function requestLimitedJson(options: {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes?: number;
  operation: string;
}): Promise<unknown>
```

Implementation requirements:

- internal `AbortController` + full-operation timer;
- race each `fetch` and each body read against abort;
- `redirect: "manual"`, max 3, same origin only, re-validate each hop with `normalizeAndValidateBaseUrl` (or origin equality + loopback/https policy);
- cancel intermediate redirect bodies;
- Content-Length early reject + streaming byte count;
- non-2xx → `HttpStatusError` without body text;
- `finally`: clear timer, remove listener, cancel reader/body.

Also export a small helper used by provider/balance:

```ts
export function isUnauthorizedStatus(error: unknown): boolean {
  return error instanceof HttpStatusError && (error.status === 401 || error.status === 403);
}
```

- [ ] **Step 4: Run HTTP tests**

```bash
npx vitest run test/http.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/http.ts test/http.test.ts test/helpers/loopback-server.ts
git commit -m "feat(http): full-operation timeout, redirects, and 5MiB body limit"
```

---

### Task 5: Slim `lib.ts` — atomic config I/O only

**Files:**
- Modify: `extensions/lib.ts`
- Create: `test/config-io.test.ts` (or add to connection tests)

- [ ] **Step 1: Write atomic write / merge tests**

```ts
import { describe, expect, it } from "vitest";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFile, saveConfigFilePreservingSecrets } from "../extensions/lib.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

describe("saveConfigFilePreservingSecrets", () => {
  it("updates non-secret fields, keeps existing apiKey, mode 0600", () => {
    const { agentDir, cleanup } = withTempAgentDir();
    try {
      writeFileSync(
        join(agentDir, "llmgates.json"),
        JSON.stringify({ apiKey: "keep-me", baseUrl: "https://old.example/v1", extra: 1 }, null, 2),
        { mode: 0o600 },
      );
      saveConfigFilePreservingSecrets(agentDir, {
        baseUrl: "https://new.example/v1",
        providerId: "llmgates",
        providerName: "LLMGates",
      });
      const raw = JSON.parse(readFileSync(join(agentDir, "llmgates.json"), "utf8"));
      expect(raw.apiKey).toBe("keep-me");
      expect(raw.baseUrl).toContain("new.example");
      expect(raw.extra).toBe(1);
      expect(statSync(join(agentDir, "llmgates.json")).mode & 0o777).toBe(0o600);
    } finally {
      cleanup();
    }
  });

  it("never writes a new login key even if caller passes one", () => {
    const { agentDir, cleanup } = withTempAgentDir();
    try {
      saveConfigFilePreservingSecrets(agentDir, {
        baseUrl: "https://new.example/v1",
        apiKey: "should-not-persist",
      } as any);
      const raw = JSON.parse(readFileSync(join(agentDir, "llmgates.json"), "utf8"));
      expect(raw.apiKey).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/config-io.test.ts
```

- [ ] **Step 3: Rewrite `extensions/lib.ts`**

Delete / stop exporting:

- `readModelsStoreEntry` / `writeModelsStoreEntry`
- `loadAuthConnection` via `readStoredCredential`
- `resolveConnection` cross-source merge
- `fetchGatewayModels` / `loadMappedModels` / `loadMappedModelsDeduped` / `fetchCreditsSnapshot`
- any direct models-store path constants used for writes

Keep / add:

```ts
export const CONFIG_FILE_NAME = "llmgates.json";
export const AUTH_FILE_NAME = "auth.json";
export const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export function loadConfigFile(agentDir: string): LLMGatesConfigFile
export function saveConfigFilePreservingSecrets(
  agentDir: string,
  patch: { baseUrl?: string; providerId?: string; providerName?: string },
): void
```

Atomic write algorithm (design §14):

1. `mkdir` parent
2. exclusive temp file `0600` in same dir
3. write full JSON (existing unknown fields preserved; `apiKey` only if already present in existing file; never from patch)
4. `fsync` file
5. `rename`
6. `chmod 0600`
7. best-effort parent dir `fsync`
8. `finally` unlink temp residue

Re-export pure helpers needed by tests/balance from `catalog`/`connection`/`http` if useful, but prefer direct imports from the owning module in new code.

- [ ] **Step 4: Run config tests**

```bash
npx vitest run test/config-io.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add extensions/lib.ts test/config-io.test.ts
git commit -m "refactor(lib): atomic llmgates.json writes without models-store I/O"
```

---

### Task 6: Native Provider core (auth + models + pending)

**Files:**
- Create: `extensions/provider.ts`
- Create: `test/provider.test.ts`
- Create: `test/helpers/auth-interaction.ts`
- Create: `test/helpers/fake-store.ts`

- [ ] **Step 1: Write AuthInteraction helper and failing login tests**

`test/helpers/auth-interaction.ts`:

```ts
import type { AuthInteraction, AuthPrompt, AuthEvent } from "@earendil-works/pi-ai";

export function scriptedAuthInteraction(answers: string[], signal?: AbortSignal): AuthInteraction & { prompts: AuthPrompt[] } {
  const prompts: AuthPrompt[] = [];
  let i = 0;
  return {
    signal,
    prompts,
    async prompt(prompt: AuthPrompt) {
      prompts.push(prompt);
      if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      if (i >= answers.length) throw new Error("unexpected prompt");
      return answers[i++]!;
    },
    notify(_event: AuthEvent) {},
  };
}
```

`test/helpers/fake-store.ts`:

```ts
import type { Model, Api, ProviderModelsStore } from "@earendil-works/pi-ai";

export function createMemoryStore(initial?: { models: Model<Api>[]; checkedAt?: number }): ProviderModelsStore & {
  writes: Array<{ models: Model<Api>[]; checkedAt?: number }>;
  failNextWrite?: Error;
} {
  let entry = initial;
  const writes: Array<{ models: Model<Api>[]; checkedAt?: number }> = [];
  return {
    writes,
    async read() {
      return entry ? { models: entry.models, checkedAt: entry.checkedAt } : undefined;
    },
    async write(next) {
      if (this.failNextWrite) {
        const err = this.failNextWrite;
        this.failNextWrite = undefined;
        throw err;
      }
      entry = { models: [...next.models], checkedAt: next.checkedAt };
      writes.push({ models: [...next.models], checkedAt: next.checkedAt });
    },
  };
}
```

Core provider tests (abbreviated but required):

```ts
import { describe, expect, it, vi } from "vitest";
import { createLLMGatesProvider } from "../extensions/provider.js";
import { scriptedAuthInteraction } from "./helpers/auth-interaction.js";
import { createMemoryStore } from "./helpers/fake-store.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

describe("native oauth login", () => {
  it("returns type oauth + validationNonce after successful validation", async () => {
    const server = await startLoopbackServer([
      { path: "/v1/models?client_version=pi", body: JSON.stringify([{ id: "m1", name: "M1" }]) },
    ]);
    const { agentDir, cleanup } = withTempAgentDir();
    try {
      const provider = createLLMGatesProvider({
        agentDir,
        providerId: "llmgates",
        providerName: "LLMGates",
      });
      const interaction = scriptedAuthInteraction([`${server.baseUrl}/v1`, "k-secret"]);
      const cred = await provider.auth.oauth!.login(interaction);
      expect(cred.type).toBe("oauth");
      expect(cred.access).toBe("k-secret");
      expect(typeof (cred as any).validationNonce).toBe("string");
      expect(interaction.prompts[0]?.type).toBe("text");
      expect(interaction.prompts[1]?.type).toBe("secret");
    } finally {
      cleanup();
      await server.close();
    }
  });

  it("retries remote http URL then accepts https/loopback", async () => {
    // first answer http://evil.example, second loopback server
  });

  it("stops after 5 failed validations with no 6th fetch", async () => {
    // count requests === 5
  });

  it("does not publish models until refresh consumes matching pending nonce", async () => {
    // login succeeds; getModels still empty; refresh with matching credential publishes
  });

  it("rejects pending consume when nonce differs even if key/baseUrl match", async () => {
    // ...
  });

  it("login store write failure still publishes in-memory models and keeps old disk entry", async () => {
    // store.failNextWrite = new Error("disk"); refresh pending path
  });

  it("normal refresh store failure retains previous models", async () => {
    // ...
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/provider.test.ts
```

- [ ] **Step 3: Implement `extensions/provider.ts`**

Factory:

```ts
export interface LLMGatesProviderOptions {
  agentDir: string;
  providerId: string;
  providerName: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface LLMGatesProvider extends Provider {
  /** test/lifecycle hooks */
  beginSession(reason: string): void;
  shutdown(): Promise<void>;
  startBackgroundRefresh(opts?: { force?: boolean }): Promise<void>;
}

export function createLLMGatesProvider(options: LLMGatesProviderOptions): LLMGatesProvider
```

Must implement:

1. **auth.apiKey** only if ambient env/file connection exists at construction:
   - `check()` side-effect free
   - `resolve()` returns `{ auth: { apiKey, baseUrl }, env: { LLMGATES_RESOLVED_BASE_URL, LLMGATES_RESOLVED_SOURCE }, source }`
   - no `login`
2. **auth.oauth** always:
   - `loginLabel: "Configure base URL + API key"`
   - `login(interaction)` 5-attempt loop with AuthInteraction
   - `refresh(credential)` offline TTL extend, preserve `validationNonce` + refresh meta
   - `toAuth(credential)` derives `{ apiKey: access, baseUrl }`
3. **pending catalog** with `validationNonce` from `randomBytes(16).toString("hex")`
4. **getModels()** sync snapshot
5. **refreshModels(context)**:
   - always capture scoped `store` handle for current generation
   - `allowNetwork: false` → restore validated cache only
   - pending consume path for post-login
   - network refresh with commit mutex + generation/request id checks
6. **stream / streamSimple** delegate to pi-ai APIs:

```ts
import {
  streamOpenAIResponses,
  streamSimpleOpenAIResponses,
  // use the exact exports present in 0.81.1 — verify before coding:
  // openAIResponsesApi / getApiProvider patterns as required by Provider interface
} from "@earendil-works/pi-ai";
```

Before coding stream methods, inspect:

```bash
rg -n "export.*(streamSimple|openAIResponses|anthropicMessages|openai-completions)" node_modules/@earendil-works/pi-ai/dist/index.d.ts | head -40
```

Match the same delegation pattern used by pi’s `createProvider` / examples for 0.81.1.

7. **lifecycle methods** used by `index.ts`:
   - `beginSession` creates session AbortController + generation bump
   - `shutdown` invalidates generation, clears pending, aborts controllers, `allSettled` tasks, drops store handle
   - `startBackgroundRefresh` non-blocking network refresh; on success and live generation, caller re-registers provider

Internal constants:

```ts
const PENDING_TTL_MS = 5 * 60 * 1000;
const CATALOG_BACKGROUND_REFRESH_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
```

Pending match:

```ts
function pendingMatches(pending, credential): boolean {
  if (!pending || !credential) return false;
  if (pending.validationNonce !== credential.validationNonce) return false;
  if (pending.connection.inferenceBaseUrl !== connectionFromCredential(credential).inferenceBaseUrl) return false;
  return timingSafeEqual(
    createHash("sha256").update(pending.connection.apiKey).digest(),
    createHash("sha256").update(credential.access).digest(),
  );
}
```

Login must call `saveConfigFilePreservingSecrets` only after successful validation, never write the login key.

- [ ] **Step 4: Run provider tests**

```bash
npx vitest run test/provider.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/provider.ts test/provider.test.ts test/helpers/auth-interaction.ts test/helpers/fake-store.ts
git commit -m "feat(provider): native Provider with validated login and scoped cache"
```

---

### Task 7: Factory + session lifecycle wiring

**Files:**
- Rewrite: `extensions/index.ts`
- Create: `test/lifecycle.test.ts`

- [ ] **Step 1: Write lifecycle tests first**

Required scenarios:

```ts
describe("factory and lifecycle", () => {
  it("does not fetch during factory registration", async () => { /* mock fetch; import factory */ });
  it("blocks registration when auth.json has type api_key", async () => {});
  it("cache-only refresh does not network", async () => {});
  it("session_start returns before hung fetch completes", async () => {});
  it("shutdown aborts in-flight work and ignores late commits", async () => {});
  it("reload: old provider commit discarded, new provider accepted", async () => {});
  it("PI_OFFLINE skips network background refresh", async () => {});
  it("store async rejection is observed and does not crash", async () => {});
});
```

Use real `createLLMGatesProvider` + fake store + hung loopback server; simulate session hooks by calling `beginSession` / `startBackgroundRefresh` / `shutdown` exactly as `index.ts` will.

- [ ] **Step 2: Run — expect FAIL for missing factory behavior**

```bash
npx vitest run test/lifecycle.test.ts
```

- [ ] **Step 3: Rewrite `extensions/index.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { detectLegacyApiKeyCredential, resolveProviderIdentity } from "./connection.js";
import { createLLMGatesProvider, type LLMGatesProvider } from "./provider.js";

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  let identity: { providerId: string; providerName: string };
  try {
    identity = resolveProviderIdentity(agentDir);
  } catch (error) {
    console.warn(`[pi-llmgates-provider] ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const legacy = detectLegacyApiKeyCredential(agentDir, identity.providerId);
  if (legacy.blocked) {
    console.warn(
      `[pi-llmgates-provider] Refusing to register ${identity.providerId}: legacy auth.json type "api_key" is blocked. Run /logout ${identity.providerName} or remove the entry, then /reload.`,
    );
    // optional: register a disabled /balance hint only — do not register provider
    return;
  }

  const provider: LLMGatesProvider = createLLMGatesProvider({
    agentDir,
    providerId: identity.providerId,
    providerName: identity.providerName,
  });

  pi.registerProvider(provider); // native overload in 0.81.x

  pi.on("session_start", async (_event, ctx) => {
    provider.beginSession(String((_event as any)?.reason ?? "start"));
    // fire-and-forget; do not await network
    void provider.startBackgroundRefresh().then(() => {
      try {
        pi.registerProvider(provider); // refresh snapshot if generation still live inside provider
      } catch {
        // old ExtensionAPI after reload is expected to throw; ignore
      }
    });
  });

  pi.on("session_shutdown", async () => {
    await provider.shutdown();
  });
}
```

Notes:

- Confirm exact `pi.registerProvider` native signature in installed types; if overload requires wrapping, follow 0.81.1 types, not 0.80 docs.
- Keep existing debug logging style (`logDebug` if already present in tree).
- Do not fetch in factory.
- Do not create long-lived module-global timers outside provider instance.

- [ ] **Step 4: Run lifecycle + existing tests**

```bash
npx vitest run test/lifecycle.test.ts test/provider.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/index.ts test/lifecycle.test.ts
git commit -m "feat(index): register native provider with fail-closed legacy gate"
```

---

### Task 8: Balance command uses canonical auth

**Files:**
- Rewrite: `extensions/balance.ts`
- Create: `test/balance.test.ts`

- [ ] **Step 1: Write balance tests**

```ts
describe("registerBalanceCommand", () => {
  it("uses modelRegistry.getProviderAuth for baseUrl and key", async () => {});
  it("shows migration message when legacy blocked flag is set", async () => {});
  it("surfaces 401/403 re-login guidance without body/key", async () => {});
  it("rejects extra args", async () => {});
  it("handles timeout and invalid JSON", async () => {});
});
```

Because `ExtensionAPI` is heavy, unit-test an extracted helper:

```ts
export async function fetchBalanceMessage(options: {
  getAuth: () => Promise<{ apiKey?: string; baseUrl?: string } | undefined>;
  signal?: AbortSignal;
  legacyBlocked?: boolean;
}): Promise<string>
```

- [ ] **Step 2: Implement balance helper + command**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requestLimitedJson, BALANCE_REQUEST_TIMEOUT_MS, isUnauthorizedStatus } from "./http.js";
import { parseCreditsPayload, formatCreditsMessage, resolveCreditsUrl } from "./catalog.js";

export async function fetchBalanceMessage(...) { /* ... */ }

export function registerBalanceCommand(
  pi: ExtensionAPI,
  providerId: string,
  options?: { legacyBlocked?: boolean },
): void {
  pi.registerCommand("balance", {
    description: "Show LLMGates account balance",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /balance", "error");
        return;
      }
      if (options?.legacyBlocked) {
        ctx.ui.notify("LLMGates blocked: remove legacy auth.json api_key entry, then /reload.", "error");
        return;
      }
      try {
        const message = await fetchBalanceMessage({
          getAuth: async () => {
            const auth = await ctx.modelRegistry.getProviderAuth(providerId);
            return auth ? { apiKey: auth.apiKey, baseUrl: auth.baseUrl } : undefined;
          },
          signal: (ctx as any).signal,
        });
        ctx.ui.notify(message, "info");
      } catch (error) {
        // no body/key in message
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
```

Wire from `index.ts`:

- normal path: `registerBalanceCommand(pi, identity.providerId)`
- legacy blocked path: still register command with `legacyBlocked: true` so users get guidance (provider remains unregistered)

Verify `getProviderAuth` exists on coding-agent model registry in 0.81.1; if the public name differs (`getAuth`), use the real API.

```bash
rg -n "getProviderAuth|getAuth\\(" node_modules/@earendil-works/pi-coding-agent/dist/core -g '*.d.ts' | head
```

- [ ] **Step 3: Run balance tests**

```bash
npx vitest run test/balance.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add extensions/balance.ts extensions/index.ts test/balance.test.ts
git commit -m "fix(balance): use canonical provider auth and bounded HTTP"
```

---

### Task 9: Pi compatibility matrix gates

**Files:**
- Create: `test/pi-compat.test.ts`

- [ ] **Step 1: Write real-API compatibility tests**

Use installed `@earendil-works/pi-ai` / coding-agent constructs:

```ts
import { describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
// plus AuthStorage / ModelRegistry if exported from coding-agent for integration

describe("pi 0.81.x compatibility", () => {
  it("registers native provider and restores cache-only models", async () => {});
  it("login order: credential store write before refreshModels", async () => {});
  it("scoped store handle works outside refresh callback in current runtime", async () => {});
  it("oauth access with ! and $ is not config-value expanded", async () => {});
  it("reload-like dispose prevents old api usage", async () => {});
});
```

Critical gate for design §10.2:

```ts
it("scoped store usable outside refresh callback", async () => {
  // capture store in refreshModels(allowNetwork:false)
  // after callback returns, await store.read()/write()
  // if this fails on 0.81.1: STOP implementation and re-open design
});
```

Literal key proof:

```ts
it("does not execute !command from oauth access", async () => {
  // sentinel file path; credential access = `!touch ${sentinel}`
  // perform auth resolve / models fetch with mock server inspecting Authorization header
  // expect header contains literal !touch... and sentinel file absent
});
```

- [ ] **Step 2: Run on baseline 0.81.1**

```bash
npx vitest run test/pi-compat.test.ts
```

If scoped-store-outside-callback fails on 0.81.1: **stop**, do not implement direct file writes, report design blocker.

- [ ] **Step 3: Optional 0.81.0 matrix**

```bash
npm install --no-save @earendil-works/pi-ai@0.81.0 @earendil-works/pi-coding-agent@0.81.0
npm test
# restore 0.81.1 afterwards
npm install
```

If only 0.81.0 fails scoped store: raise peerDependency floor to `>=0.81.1 <0.82.0` and document in README.

- [ ] **Step 4: Commit**

```bash
git add test/pi-compat.test.ts package.json package-lock.json README.md
git commit -m "test: add pi 0.81.x native provider compatibility gates"
```

---

### Task 10: README + package metadata alignment

**Files:**
- Modify: `README.md`
- Modify: `package.json` description/engines only if needed (no unsolicited version bump)

- [ ] **Step 1: Update README sections to match design §18**

Must include:

- Node `>=22.19.0`, pi `>=0.81.0` (or `>=0.81.1` if matrix raised floor)
- no pi 0.80.x support; native Provider reason
- OAuth whole-connection priority
- env/file only without login credential; source binding
- `/logout` restores ambient; existing file apiKey preserved across login
- login validates first, max 5 attempts; URL policy retryable
- cache-first startup + non-blocking session refresh
- HTTPS + loopback HTTP only (incl. IPv4-mapped)
- unsupported: `models.json` `apiKey` overlay for this provider
- legacy `auth.json type:"api_key"` manual migration
- store write failure behaviors
- `/balance` same connection
- `PI_OFFLINE`

Remove any claim of legacy `ProviderConfig` oauth callbacks or pi 0.80 support.

- [ ] **Step 2: Commit**

```bash
git add README.md package.json
git commit -m "docs: document native provider security and migration behavior"
```

---

### Task 11: Full verification and freeze

**Files:** none intentional; verify only

- [ ] **Step 1: Typecheck + tests**

```bash
npm run typecheck
npm test
npm run check
```

Expected: all pass; typecheck includes tests.

- [ ] **Step 2: Pack and audit**

```bash
npm pack --dry-run --json
npm audit --package-lock-only
git diff --check
git status --short
```

Expected:

- pack contains only `extensions/**`, `README.md`, `LICENSE`
- no test secrets / temp agent dirs
- audit findings recorded honestly

- [ ] **Step 3: Grep regressions**

```bash
rg -n "readStoredCredential|writeModelsStoreEntry|readModelsStoreEntry|OAuthLoginCallbacks|ProviderConfig|fetchWithTimeout|models-store\\.json" extensions
rg -n "LLMGATES_ALLOW_INSECURE|createProvider\\(" extensions
```

Expected: no legacy models-store writes, no `OAuthLoginCallbacks`, no insecure override, no `createProvider` factory path for main provider.

- [ ] **Step 4: Manual smoke checklist (document results in commit message or notes)**

1. unconfigured → `/login` oauth multi-field
2. env key only
3. file key only
4. oauth overrides env/file
5. legacy api_key → provider absent + warning
6. `/reload` during hung network does not crash
7. `/balance`
8. `PI_OFFLINE=1`

- [ ] **Step 5: Final commit if only doc/test fixups remain**

```bash
git add -A
git status --short
git commit -m "chore: finalize native provider security hardening verification"
```

Only commit if there are intentional remaining changes; do not force-add secrets.

---

## Implementation order summary

1. Tooling / pi 0.81.1  
2. Catalog strict parse  
3. Connection + URL policy  
4. HTTP bounds  
5. Atomic config I/O  
6. Native Provider  
7. Factory + lifecycle  
8. Balance  
9. Pi-compat gates (hard stop if scoped store unusable on 0.81.1)  
10. README  
11. Full verification  

---

## Self-review against design

| Design section | Task coverage |
|---|---|
| §3 native Provider, not createProvider | Tasks 6–7 |
| §4 module boundaries | File map + Tasks 2–8 |
| §5 auth ownership / ambient / oauth / legacy fail closed | Tasks 3, 6, 7 |
| §6 URL + redirects | Tasks 3–4 |
| §7 bounded network | Task 4 |
| §8 strict parse | Task 2 |
| §9 login transaction + nonce pending | Task 6 |
| §10 scoped store + commit rules | Tasks 6–7, 9 |
| §11 refresh paths | Tasks 6–7 |
| §12 concurrency/lifecycle | Tasks 6–7 |
| §13 balance | Task 8 |
| §14 atomic config + builtin id + models.json boundary | Tasks 3, 5, 10 |
| §15 tests | Tasks 2–9 |
| §16–17 deps/audit | Tasks 1, 11 |
| §18–20 README + acceptance | Tasks 10–11 |

No intentional placeholders remain. Stream API import names must be confirmed against installed 0.81.1 d.ts in Task 6 before coding — that is a lookup step, not an open design question.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-22-native-provider-security-hardening-plan.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with executing-plans checkpoints  

Which approach?
