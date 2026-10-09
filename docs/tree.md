# pubmed-mcp-server - Directory Structure

Generated on: 2026-10-09 17:17:56

```text
pubmed-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 2.0.x/
│   ├── 2.1.x/
│   ├── 2.10.x/
│   ├── 2.2.x/
│   ├── 2.3.x/
│   ├── 2.4.x/
│   ├── 2.5.x/
│   ├── 2.6.x/
│   ├── 2.7.x/
│   ├── 2.8.x/
│   ├── 2.9.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── mcpmed-pr-draft.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
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
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
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
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
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
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── corpus-add.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   └── tree.ts
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
│   │           ├── _budget.ts
│   │           ├── _concepts.ts
│   │           ├── _schemas.ts
│   │           ├── _text.ts
│   │           ├── _visible-text.ts
│   │           ├── convert-ids.tool.ts
│   │           ├── fetch-articles.tool.ts
│   │           ├── fetch-fulltext.tool.ts
│   │           ├── find-related.tool.ts
│   │           ├── format-citations.tool.ts
│   │           ├── lookup-citation.tool.ts
│   │           ├── lookup-mesh.tool.ts
│   │           ├── pubmed-europepmc-fetch.tool.ts
│   │           ├── pubmed-europepmc-search.tool.ts
│   │           ├── search-articles.tool.ts
│   │           └── spell-check.tool.ts
│   ├── services/
│   │   ├── europe-pmc/
│   │   │   ├── api-client.ts
│   │   │   ├── europe-pmc-service.ts
│   │   │   ├── request-queue.ts
│   │   │   └── types.ts
│   │   ├── ncbi/
│   │   │   ├── formatting/
│   │   │   │   └── citation-formatter.ts
│   │   │   ├── parsing/
│   │   │   │   ├── article-parser.ts
│   │   │   │   ├── esummary-parser.ts
│   │   │   │   ├── ordered-xml-parser-options.ts
│   │   │   │   ├── pmc-article-parser.ts
│   │   │   │   ├── pmc-xml-helpers.ts
│   │   │   │   ├── text-helpers.ts
│   │   │   │   └── xml-helpers.ts
│   │   │   ├── api-client.ts
│   │   │   ├── ncbi-service.ts
│   │   │   ├── request-queue.ts
│   │   │   ├── response-handler.ts
│   │   │   └── types.ts
│   │   ├── openalex/
│   │   │   ├── api-client.ts
│   │   │   ├── openalex-service.ts
│   │   │   └── types.ts
│   │   ├── unpaywall/
│   │   │   ├── types.ts
│   │   │   └── unpaywall-service.ts
│   │   ├── error-contracts.ts
│   │   └── fetch-redaction.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── corpus/
│   │   ├── fixtures/
│   │   │   ├── pmc/
│   │   │   │   ├── pmc10455816/
│   │   │   │   │   ├── expect.json
│   │   │   │   │   ├── expected.md
│   │   │   │   │   ├── meta.json
│   │   │   │   │   └── source.xml
│   │   │   │   ├── pmc10666927/
│   │   │   │   │   ├── expect.json
│   │   │   │   │   ├── expected.md
│   │   │   │   │   ├── meta.json
│   │   │   │   │   └── source.xml
│   │   │   │   ├── pmc10707391/
│   │   │   │   │   ├── expect.json
│   │   │   │   │   ├── expected.md
│   │   │   │   │   ├── meta.json
│   │   │   │   │   └── source.xml
│   │   │   │   ├── pmc10754557/
│   │   │   │   │   ├── expect.json
│   │   │   │   │   ├── expected.md
│   │   │   │   │   ├── meta.json
│   │   │   │   │   └── source.xml
│   │   │   │   ├── pmc10799778/
│   │   │   │   │   ├── expect.json
│   │   │   │   │   ├── expected.md
│   │   │   │   │   ├── meta.json
│   │   │   │   │   └── source.xml
│   │   │   │   ├── pmc11176230/
│   │   │   │   │   ├── expect.json
│   │   │   │   │   ├── expected.md
│   │   │   │   │   ├── meta.json
│   │   │   │   │   └── source.xml
│   │   │   │   ├── pmc11292240/
│   │   │   │   │   ├── expect.json
│   │   │   │   │   ├── expected.md
│   │   │   │   │   ├── meta.json
│   │   │   │   │   └── source.xml
│   │   │   │   ├── pmc11609225/
│   │   │   │   │   ├── expect.json
│   │   │   │   │   ├── expected.md
│   │   │   │   │   ├── meta.json
│   │   │   │   │   └── source.xml
│   │   │   │   └── pmc12806063/
│   │   │   │       ├── expect.json
│   │   │   │       ├── expected.md
│   │   │   │       ├── meta.json
│   │   │   │       └── source.xml
│   │   │   └── pubmed/
│   │   │       ├── pmid31844417/
│   │   │       │   ├── expect.json
│   │   │       │   ├── expected.md
│   │   │       │   ├── meta.json
│   │   │       │   └── source.xml
│   │   │       ├── pmid34026693/
│   │   │       │   ├── expect.json
│   │   │       │   ├── expected.md
│   │   │       │   ├── meta.json
│   │   │       │   └── source.xml
│   │   │       ├── pmid34116029/
│   │   │       │   ├── expect.json
│   │   │       │   ├── expected.md
│   │   │       │   ├── meta.json
│   │   │       │   └── source.xml
│   │   │       ├── pmid38206746/
│   │   │       │   ├── expect.json
│   │   │       │   ├── expected.md
│   │   │       │   ├── meta.json
│   │   │       │   └── source.xml
│   │   │       ├── pmid38869518/
│   │   │       │   ├── expect.json
│   │   │       │   ├── expected.md
│   │   │       │   ├── meta.json
│   │   │       │   └── source.xml
│   │   │       └── pmid39624286/
│   │   │           ├── expect.json
│   │   │           ├── expected.md
│   │   │           ├── meta.json
│   │   │           └── source.xml
│   │   ├── ATTRIBUTION.md
│   │   ├── attribution.ts
│   │   ├── corpus.test.ts
│   │   ├── expect.ts
│   │   ├── features.ts
│   │   ├── fixtures.ts
│   │   ├── invariants.test.ts
│   │   ├── invariants.ts
│   │   ├── meta.test.ts
│   │   ├── pubmed-checks.test.ts
│   │   ├── pubmed-corpus.test.ts
│   │   ├── pubmed-expect.ts
│   │   ├── pubmed-fixtures.ts
│   │   ├── pubmed-invariants.ts
│   │   ├── pubmed-meta.test.ts
│   │   ├── pubmed-run-tools.ts
│   │   └── run-tool.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── research-plan.prompt.test.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       └── database-info.resource.test.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── _budget.test.ts
│   │           ├── _fuzz-helpers.ts
│   │           ├── _schemas.test.ts
│   │           ├── _text.test.ts
│   │           ├── _visible-text.test.ts
│   │           ├── convert-ids-per-element.test.ts
│   │           ├── convert-ids.tool.test.ts
│   │           ├── europepmc-search-failures.test.ts
│   │           ├── fetch-articles.record-fields.test.ts
│   │           ├── fetch-articles.tool.test.ts
│   │           ├── fetch-fulltext-jats-sections.test.ts
│   │           ├── fetch-fulltext-jats-text.test.ts
│   │           ├── fetch-fulltext-routing.test.ts
│   │           ├── fetch-fulltext.tool.test.ts
│   │           ├── find-related-openalex-reason.test.ts
│   │           ├── find-related.tool.test.ts
│   │           ├── format-citations.tool.test.ts
│   │           ├── input-aliases.test.ts
│   │           ├── lookup-citation-esummary.test.ts
│   │           ├── lookup-citation-truncation.test.ts
│   │           ├── lookup-citation.tool.test.ts
│   │           ├── lookup-mesh.tool.test.ts
│   │           ├── pubmed-europepmc-fetch.tool.test.ts
│   │           ├── pubmed-europepmc-search.tool.test.ts
│   │           ├── search-articles-count-only.test.ts
│   │           ├── search-articles.tool.test.ts
│   │           ├── security.test.ts
│   │           ├── spell-check.tool.test.ts
│   │           ├── tools.fuzz.test.ts
│   │           ├── unknown-pmid-envelope.test.ts
│   │           └── zero-padded-pmid.test.ts
│   ├── services/
│   │   ├── europe-pmc/
│   │   │   ├── europe-pmc-abstract.test.ts
│   │   │   └── europe-pmc-service.test.ts
│   │   ├── ncbi/
│   │   │   ├── formatting/
│   │   │   │   ├── citation-formatter.edge.test.ts
│   │   │   │   └── citation-formatter.test.ts
│   │   │   ├── parsing/
│   │   │   │   ├── _book-fixtures.ts
│   │   │   │   ├── _comments-corrections-fixtures.ts
│   │   │   │   ├── _investigator-fixtures.ts
│   │   │   │   ├── article-parser.test.ts
│   │   │   │   ├── esummary-parser.test.ts
│   │   │   │   ├── pmc-article-parser.test.ts
│   │   │   │   ├── pmc-xml-helpers.test.ts
│   │   │   │   ├── text-helpers.test.ts
│   │   │   │   └── xml-helpers.test.ts
│   │   │   ├── api-client.test.ts
│   │   │   ├── ecitmatch-truncation.test.ts
│   │   │   ├── efetch-timeout-retry.test.ts
│   │   │   ├── idconvert-http-400.test.ts
│   │   │   ├── ncbi-service.test.ts
│   │   │   ├── rate-limit-cooldown.test.ts
│   │   │   ├── request-queue.test.ts
│   │   │   ├── response-handler.inline-markup.test.ts
│   │   │   ├── response-handler.test.ts
│   │   │   └── transient-500-retry.test.ts
│   │   ├── openalex/
│   │   │   └── openalex-service.test.ts
│   │   ├── unpaywall/
│   │   │   └── unpaywall-service.test.ts
│   │   ├── error-contracts.test.ts
│   │   └── retry-gate.test.ts
│   ├── tools/
│   ├── _helpers.ts
│   └── index.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
