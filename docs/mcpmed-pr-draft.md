# MCPmed Listing — PR Draft

**Status:** Draft. Nothing has been posted. Review and edit before opening the PR.

**Target repo:** https://github.com/MCPmed/.github
**Target file:** `profile/README.md` (renders as the MCPmed org landing page)
**Type:** Single-file edit — new section + one table row.

---

## Context

MCPmed is a small research-group initiative from Saarland University (Flotho et al.) proposing MCP servers for bioinformatics databases. Published in *Briefings in Bioinformatics* 2026 (doi:10.1093/bib/bbag076). GitHub org has ~21 followers, 11 repos, 2 visible maintainers.

Their paper lists GEO, STRING, UCSC Cell Browser, PLSDB as reference implementations but **has no native PubMed server** — their `paperscraperMCP` is a fork of `jannisborn/paperscraper` that scrapes publications rather than using NCBI E-utilities. That's the gap we're filling.

They already accept TypeScript (`PBMCpediaMCP`, `breadcrumbsMCP` are TS) and non-BSD licenses (`paperscraperMCP` is MIT, `PLSDBmcp` license is "Not specified"). Apache 2.0 should be fine.

---

## Proposed PR

### Title

```
Add Community MCP Servers section with cyanheads/pubmed-mcp-server
```

### Body

```markdown
Proposes a new **Community MCP Servers** table for externally-maintained
MCP servers that align with the MCPmed mission but aren't hosted in this org,
and seeds it with `cyanheads/pubmed-mcp-server`.

## Why a new section

The existing **Active MCP Servers** table lists repos owned by the MCPmed
org. As the paper explicitly calls for a community effort, a dedicated place
for community-hosted, MCPmed-aligned servers lowers the barrier to
contribution while preserving the provenance distinction. Happy to fold into
an existing section instead if preferred.

## Why this server

`cyanheads/pubmed-mcp-server` is a production-grade MCP server for the NCBI
E-utilities API, complementing `paperscraperMCP` (which scrapes publications
from multiple sources) with a native, schema-validated E-utilities integration:

- **9 tools** covering ESearch, EFetch, ESummary, ELink, ESpell, EInfo,
  ECitMatch, and the PMC ID Converter
- **Full-text retrieval** from PubMed Central with section filtering
- **MeSH vocabulary lookup** (tree numbers, scope notes, entry terms) —
  essential for building precise PubMed queries
- **Citation formatting** in APA, MLA, BibTeX, RIS (zero deps, Workers-compatible)
- **Deterministic citation matching** via ECitMatch for known references
- Three transports: **stdio, Streamable HTTP, Cloudflare Workers**

Distribution: [@cyanheads/pubmed-mcp-server on npm](https://www.npmjs.com/package/@cyanheads/pubmed-mcp-server),
Docker image at `ghcr.io/cyanheads/pubmed-mcp-server`, and a public hosted
instance at `https://pubmed.caseyjhand.com/mcp`.

## Semantic concept annotations

Following the paper's proposal for ontology-backed concept mapping, every tool
definition carries a `_meta` field with resolvable URIs from Schema.org and
EDAM — `SearchAction`, `ScholarlyArticle`, `DefinedTerm`,
`operation_2421` (Database search), `operation_2422` (Data retrieval),
`operation_3282` (ID mapping), `operation_0335` (Data formatting),
`topic_0089` (Ontology and terminology), `data_1187` (PubMed ID),
`data_2091` (Accession) — rather than placeholder strings.

Currently under the key `_meta['io.mcpmed/concepts']` as a proposal. Happy
to align with whatever key MCPmed settles on; if the project wants to
formalize a shape (e.g., `{ id, label }` objects vs. bare URIs, label
language tags, scheme URI, etc.), I'm glad to adapt and contribute the
convention upstream.

## License

Apache 2.0. For consumers (listing or depending on the server), this is
compatible with BSD-3-Clause or MIT downstream. If the project prefers all
listed servers to be BSD-3/MIT, let me know and I'll evaluate a relicense.

## Links

- Repository: https://github.com/cyanheads/pubmed-mcp-server
- npm: https://www.npmjs.com/package/@cyanheads/pubmed-mcp-server
- Paper: Flotho et al., *Briefings in Bioinformatics* 2026, doi:10.1093/bib/bbag076
```

### Diff for `profile/README.md`

Insert this new section immediately after the existing **Active MCP Servers** table, before **Development Tools & Templates**:

```markdown
## Community MCP Servers

Externally-maintained MCP servers that align with the MCPmed mission but are hosted in separate repositories.

| Repository | Description | Language | License |
|------------|-------------|----------|---------|
| **[cyanheads/pubmed-mcp-server](https://github.com/cyanheads/pubmed-mcp-server)** | MCP server for the NCBI E-utilities API. Nine tools covering PubMed search, article fetch, PMC full text, MeSH vocabulary lookup, citation formatting (APA/MLA/BibTeX/RIS), ECitMatch, and ID conversion (DOI/PMID/PMCID). Tool definitions carry ontology-backed concept tags (Schema.org, EDAM) via `_meta`. stdio, Streamable HTTP, and Cloudflare Workers transports. Published on npm and GHCR. | TypeScript | Apache 2.0 |
```

---

## Pre-flight checklist

Before opening the PR:

- [ ] Review uncommitted concept-tag changes locally (`git diff`) and commit them
- [ ] Confirm the `_meta['io.mcpmed/concepts']` namespace is acceptable to you as a public proposal (or rename first)
- [ ] Decide whether to link the hosted instance at `pubmed.caseyjhand.com` in the PR body (currently included — personal domain trade-off)
- [ ] Fork `MCPmed/.github`, apply the diff above, open the PR with the title + body above
- [ ] Optional: attach a short screenshot or asciinema of the server in action — stronger than the README alone

## Risk notes

- Their contribution guidelines say "Maintain BSD-3-Clause or MIT licensing compatibility." Apache 2.0 is one-way compatible for consumers but not strictly BSD-3/MIT. We preempt this in the PR body; if they reject on license grounds, options are: (1) add a dual-license note to the repo, (2) relicense, (3) drop the listing.
- Repo ownership stays at `cyanheads/`. We are not proposing transfer.
- The `io.mcpmed/concepts` key presumes a namespace on their behalf. If they push back, fallback names: `com.cyanheads/concepts`, `bio.schema/concepts`, or whatever they prefer.
