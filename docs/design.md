# PubMed MCP Server — Design

## MCP Surface

### Tools

| Name | Old Name | Description | Key Inputs | Annotations |
|:-----|:---------|:------------|:-----------|:------------|
| `pubmed_search_articles` | `pubmed_search` | Search PubMed with full query syntax, field-specific filters, date ranges, pagination, and optional brief summaries. | `query`, `author?`, `journal?`, `meshTerms?`, `dateRange?`, `pubType?`, `sort?`, `maxResults?`, `offset?`, `includeSummaries?` | `readOnlyHint: true` |
| `pubmed_fetch_articles` | `pubmed_fetch` | Fetch full article metadata by PubMed IDs — abstract, authors, journal, MeSH terms, grants. Batch up to 200. | `pmids`, `includeMesh?`, `includeGrants?` | `readOnlyHint: true` |
| `pubmed_fetch_fulltext` | `pubmed_pmc_fetch` | Fetch full-text articles from PubMed Central. Accepts PMIDs (auto-resolved) or PMCIDs. Section filtering, optional references. Up to 10 per request. | `ids`, `sections?`, `includeReferences?`, `maxSections?` | `readOnlyHint: true` |
| `pubmed_format_citations` | `pubmed_cite` | Generate formatted citations in APA 7th, MLA 9th, BibTeX, or RIS. Multiple styles per article. Up to 50 per request. | `pmids`, `styles` | `readOnlyHint: true` |
| `pubmed_find_related` | `pubmed_related` | Find similar articles, citing articles, or references for a given PMID. Results enriched with title, authors, date. | `pmid`, `relationship` (`similar`, `cited_by`, `references`) | `readOnlyHint: true` |
| `pubmed_spell_check` | `pubmed_spell` | Spell-check a biomedical query using NCBI's ESpell service. Returns original, corrected, and whether a suggestion was found. | `query` | `readOnlyHint: true` |
| `pubmed_lookup_mesh` | `pubmed_mesh_lookup` | Search and explore MeSH vocabulary — tree numbers, scope notes, entry terms. Useful for building precise PubMed queries. | `term`, `detailed?` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `pubmed://database/info` | PubMed database metadata via EInfo (field list, record count, last update). | No |

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `research_plan` | Generate a structured 4-phase biomedical research plan outline. | `topic`, `scope?` |

## Rename Summary

All tools now follow `{domain}_{verb}_{noun}` (3 words):

| Before | After | Rationale |
|:-------|:------|:----------|
| `pubmed_search` | `pubmed_search_articles` | Added noun |
| `pubmed_fetch` | `pubmed_fetch_articles` | Added noun |
| `pubmed_pmc_fetch` | `pubmed_fetch_fulltext` | "PMC" is implementation detail; capability is fulltext |
| `pubmed_cite` | `pubmed_format_citations` | Verb + noun |
| `pubmed_related` | `pubmed_find_related` | "related" isn't a verb |
| `pubmed_spell` | `pubmed_spell_check` | Completes the phrase |
| `pubmed_mesh_lookup` | `pubmed_lookup_mesh` | Verb before noun |

## Implementation Notes

- All tools are read-only (`readOnlyHint: true`, `destructiveHint: false`)
- No auth scopes needed (public NCBI API, optional API key for rate limits)
- Single service layer: `NcbiService` wrapping E-utilities with sequential request queue
- Rename is tool name only — file names should update to match (e.g., `search-articles.tool.ts`)
- No changes to input/output schemas, handler logic, or service layer
