# pubmed-mcp-server - Directory Structure

Generated on: 2026-03-23 19:20:13

```text
pubmed-mcp-server/
├── .github/
│   └── FUNDING.yml
├── .storage/
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── claude-plans/
├── docs/
│   └── design.md
├── schemas/
│   └── ncbi-dtd/
│       ├── eInfo_020511.dtd
│       ├── eLink_020511.dtd
│       ├── ePost_020511.dtd
│       ├── eSearch_020511.dtd
│       ├── eSpell.dtd
│       ├── eSummary_041029.dtd
│       └── pubmed_250101.dtd
├── scripts/
│   ├── build.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   └── tree.ts
├── skills/
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── devcheck/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── migrate-mcp-ts-template/
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   └── setup/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── research-plan.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       └── database-info.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── fetch-articles.tool.ts
│   │           ├── fetch-fulltext.tool.ts
│   │           ├── find-related.tool.ts
│   │           ├── format-citations.tool.ts
│   │           ├── lookup-mesh.tool.ts
│   │           ├── search-articles.tool.ts
│   │           └── spell-check.tool.ts
│   ├── services/
│   │   └── ncbi/
│   │       ├── formatting/
│   │       │   └── citation-formatter.ts
│   │       ├── parsing/
│   │       │   ├── article-parser.ts
│   │       │   ├── esummary-parser.ts
│   │       │   ├── pmc-article-parser.ts
│   │       │   └── xml-helpers.ts
│   │       ├── api-client.ts
│   │       ├── ncbi-service.ts
│   │       ├── request-queue.ts
│   │       ├── response-handler.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── prompts/
│   ├── resources/
│   └── tools/
├── .dockerignore
├── .env.example
├── .gitignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
