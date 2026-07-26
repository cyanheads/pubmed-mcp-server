# Agent Protocol

**Server:** @cyanheads/pubmed-mcp-server
**Version:** 2.10.2
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.11.0`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit`** for presence before calling (`if (ctx.elicit) { ... }` — defined only when the client advertised elicitation capability).
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';

export const spellCheckTool = tool('pubmed_spell_check', {
  description: "Spell-check a query and get NCBI's suggested correction.",
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z.string().min(2).describe('PubMed search query to spell-check'),
  }),

  output: z.object({
    original: z.string().describe('Original query'),
    corrected: z.string().describe('Corrected query (same as original if no suggestion)'),
    hasSuggestion: z.boolean().describe('Whether NCBI suggested a correction'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_spell_check tool', { query: input.query });
    const result = await getNcbiService().eSpell({ db: 'pubmed', term: input.query });
    return { original: result.original, corrected: result.corrected, hasSuggestion: result.hasSuggestion };
  },

  format: (result) => {
    if (result.hasSuggestion) {
      return [{ type: 'text', text: `**Suggested correction:** "${result.corrected}" (original: "${result.original}")` }];
    }
    return [{ type: 'text', text: `No spelling corrections suggested for: "${result.original}"` }];
  },
});
```

### Resource

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';

export const databaseInfoResource = resource('pubmed://database/info', {
  name: 'database-info',
  title: 'PubMed Database Info',
  description: 'PubMed database metadata including field list, last update date, and record count.',
  mimeType: 'application/json',
  params: z.object({}),
  output: OutputSchema,

  async handler(_params, ctx) {
    ctx.log.info('Fetching PubMed database info');
    const raw = await getNcbiService().eInfo({ db: 'pubmed' });
    // ... parse XML response ...
    return { dbName, description, count, lastUpdate, fields };
  },

  list: () => ({
    resources: [{ uri: 'pubmed://database/info', name: 'PubMed Database Info' }],
  }),
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v);

const ServerConfigSchema = z.object({
  apiKey: z.preprocess(emptyAsUndefined, z.string().optional()).describe('NCBI API key'),
  toolIdentifier: z.string().default('pubmed-mcp-server').describe('NCBI tool identifier'),
  adminEmail: z.preprocess(emptyAsUndefined, z.email().optional()).describe('Admin contact email'),
  requestDelayMs: z.coerce.number().min(50).max(5000).default(334).describe('Request delay in ms'),
  maxRetries: z.coerce.number().min(0).max(10).default(6).describe('Max retry attempts'),
  timeoutMs: z.coerce.number().min(1000).max(120000).default(30000).describe('Request timeout in ms'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'NCBI_API_KEY',
    toolIdentifier: 'NCBI_TOOL_IDENTIFIER',
    adminEmail: 'NCBI_ADMIN_EMAIL',
    requestDelayMs: 'NCBI_REQUEST_DELAY_MS',
    maxRetries: 'NCBI_MAX_RETRIES',
    timeoutMs: 'NCBI_TIMEOUT_MS',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`NCBI_REQUEST_DELAY_MS` must be a number) rather than the internal path (`requestDelayMs: expected number`).

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` accepts optional identity fields forwarded to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

```ts
await createApp({
  name: 'pubmed-mcp-server',
  title: 'pubmed-mcp-server',  // must match the unscoped package name — enforced by lint:packaging
  websiteUrl: 'https://github.com/cyanheads/pubmed-mcp-server',
  description: 'One-line description.',
  icons: [{ src: 'https://example.com/icon.png', sizes: ['48x48'], mimeType: 'image/png' }],
  instructions: 'Use shortcut alpha for the most common case.',
});
```

`instructions` is optional server-level orientation, sent on every `initialize` as session-level context. Use it for deployment guidance (connection aliases, regional notes, scope hints) instead of repeating the same context across tool descriptions. Client adoption is uneven, but there's no downside when set.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.elicit` | Ask user for structured input — form call `(message, schema)` or `.url(message, url)` for an external link. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.enrich` | Success-path agent context (empty-result notices, query echo, pagination totals) — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). |
| `ctx.content` | Non-text content blocks — `.image(data, mimeType)`, `.audio(data, mimeType)`, or `ctx.content(block)` for a raw block. Prepended to `content[]` after `format()`; never enters `structuredContent`. |
| `ctx.recoveryFor(reason)` | Typed lookup of the contract `recovery` for a declared reason. Returns `{ recovery: { hint } }` for known reasons, `{}` otherwise. Spread into `ctx.fail` data to mirror the contract hint into `content[]`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT, `'default'` for stdio or HTTP+`MCP_AUTH_MODE=none`. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required (≥ 5 words, lint-validated) — it's the single source of truth for the recovery hint. Spread `ctx.recoveryFor('reason')` into `data` to mirror the contract recovery onto the wire (the framework mirrors `data.recovery.hint` into `content[]` text); pass an explicit `recovery: { hint: '...' }` when runtime context matters. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No requested PMID returned data',
    recovery: 'Try pubmed_search_articles to discover valid PMIDs first.' },
],
async handler(input, ctx) {
  const articles = await ncbi.fetch(input.pmids);
  if (articles.length === 0) {
    // Static contract recovery
    throw ctx.fail('no_match', `None of ${input.pmids.length} PMIDs returned data`, {
      ...ctx.recoveryFor('no_match'),
    });
  }
  return { articles };
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** error factories or plain `Error`.

```ts
// Error factories — explicit code, concise
import { notFound, serializationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });
throw serializationError('Invalid XML response', { endpoint });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — full control when the code is dynamic
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

For HTTP responses, prefer `httpErrorFromResponse(response, { service, data })` from `/utils` over hand-rolled status ladders — covers the full 4xx/5xx → `JsonRpcErrorCode` table and captures body + `Retry-After`.

**Service-layer:** services don't have `ctx.fail`. To carry a contract `reason` from a service throw, pass `data: { reason: 'X' }` to the factory — the auto-classifier preserves `data` on the wire so clients see the same `error.data.reason` they'd see from `ctx.fail`.

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # NCBI-specific env vars (Zod schema)
  services/
    ncbi/
      ncbi-service.ts                   # NCBI E-utilities service (init/accessor)
      api-client.ts                     # HTTP client for NCBI API
      request-queue.ts                  # Rate-limited request queue
      response-handler.ts              # XML response parsing
      types.ts                          # NCBI/PubMed domain types
      parsing/                          # XML parsers (article, esummary, PMC)
      formatting/                       # Citation formatter (APA, MLA, BibTeX, RIS)
  mcp-server/
    tools/definitions/                  # 11 tool definitions (*.tool.ts)
    resources/definitions/              # database-info.resource.ts
    prompts/definitions/                # research-plan.prompt.ts
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-articles.tool.ts` |
| Tool/resource/prompt names | snake_case | `pubmed_search_articles` |
| Directories | kebab-case | `src/services/ncbi/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search PubMed with full query syntax.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of definition language: voice, leaks, defaults, recovery hints, examples |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-mirror` | MirrorService: persistent, self-refreshing local SQLite mirror of bulk upstream datasets — Tier 3 opt-in, Node/Bun only |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |
| `techniques` | Catalog of reusable response/data-shaping patterns — overflow handling, payload shaping, retrieval. Use when a payload is too large, awkwardly shaped, or expensive to retrieve |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + packaging alignment |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — `bun update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run lint:packaging` | Validate env var alignment between `manifest.json` and `server.json` (skipped cleanly when `manifest.json` is absent) |
| `bun run list-skills` | List skills in `skills/` with name + description |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create GitHub Release from an annotated tag — enforces `v<VERSION>: <subject>` title, attaches `.mcpb` bundle |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Bundling

`bun run bundle` produces `dist/pubmed-mcp-server.mcpb` for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. MCPB is stdio-only — HTTP and Docker deployments are unaffected. The `release-and-publish` skill attaches the bundle to the GitHub Release at a stable `releases/latest/download/pubmed-mcp-server.mcpb` URL that powers the README install badge.

**Adding an env var requires both files**: `server.json` stdio `environmentVariables[]` (registry discovery) and `manifest.json` `mcp_config.env` (bundle install UX, plus `user_config` if user-prompted). `bun run lint:packaging` (run by `devcheck`) verifies the env var names align.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/2.9.x/2.9.8.md`) — one file per release. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`).

`agent-notes` is an optional free-form field consumed by agents running the `maintenance` skill downstream — adoption instructions that don't fit the human-facing sections. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

Run the `release-and-publish` skill after git wrapup — it runs the verification gate (`devcheck`, `rebuild`, `test`), pushes commits and tags, and publishes to npm, the MCP Registry, GHCR, and attaches the `.mcpb` bundle to the GitHub Release, halting on the first failure. For reference, the underlying commands are:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/pubmed-mcp-server:<version> \
  -t ghcr.io/cyanheads/pubmed-mcp-server:latest \
  --push .

mcp-publisher publish
```

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] NCBI wrapping: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] NCBI wrapping: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] NCBI wrapping: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
