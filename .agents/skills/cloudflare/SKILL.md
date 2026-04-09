---
name: cloudflare
description: "Cloudflare Workers development skills: building and deploying MCP servers on Workers, Workers code review and best practices enforcement, and Wrangler CLI usage for managing Workers, KV, R2, D1, Vectorize, Hyperdrive, Queues, and other Cloudflare services. Use when building on Cloudflare Workers, reviewing Workers code, deploying with Wrangler, or configuring Cloudflare bindings and services."
---

# Cloudflare

Parent skill for Cloudflare Workers development, deployment, and best practices. Load the appropriate sub-skill based on the task.

## Sub-Skills

| Task | Sub-Skill |
|------|-----------|
| Build and deploy MCP servers on Cloudflare Workers | [building-mcp-server-on-cloudflare/SKILL.md](./building-mcp-server-on-cloudflare/SKILL.md) |
| Review Workers code, enforce best practices, catch anti-patterns | [workers-best-practices/SKILL.md](./workers-best-practices/SKILL.md) |
| Run Wrangler CLI commands for dev, deploy, and service management | [wrangler/SKILL.md](./wrangler/SKILL.md) |

## When to Use

- **building-mcp-server-on-cloudflare**: Building a remote MCP server on Workers, adding tools/auth, or deploying MCP to Cloudflare.
- **workers-best-practices**: Writing or reviewing Workers code. Checking for streaming, floating promises, global state, secrets handling, binding access, or config issues.
- **wrangler**: Running Wrangler commands — dev server, deploy, secrets, KV/R2/D1/Vectorize/Hyperdrive management, type generation, or troubleshooting CLI issues.

## When NOT to Use

- General Node.js/TypeScript development unrelated to Cloudflare Workers
- Cloudflare products outside Workers (e.g., DNS, CDN caching rules, Zero Trust)
- Local-only MCP server development without a Workers deployment target
