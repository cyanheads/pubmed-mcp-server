/**
 * @fileoverview Page-size fields that serve up to a per-call cap instead of
 * rejecting past it: the ceiling the field advertises, which still refuses
 * absurd input, and the notice sentence a clamped call adds. Shared by
 * `pubmed_search_articles`, `pubmed_find_related`, `pubmed_lookup_mesh`, and
 * `pubmed_europepmc_search`. (#232)
 * @module src/mcp-server/tools/definitions/_page-size
 */

/**
 * The `.max()` a page-size field advertises: ten times its per-call cap. A
 * value between the cap and this ceiling is served at the cap; a value past it
 * is still rejected as an input error.
 */
export function pageSizeCeiling(cap: number): number {
  return cap * 10;
}

/**
 * The notice sentence for a call whose page size was clamped to `cap`.
 * `continuation` is the tool's own sentence naming how to read what the page
 * left out (the next `offset`, a cursor, another tool); omit it when every
 * result fit.
 */
export function pageSizeClampNotice(
  field: string,
  requested: number,
  cap: number,
  continuation?: string,
): string {
  const head = `\`${field}\` ${requested} is past the per-call cap of ${cap}, so it is served at ${cap}.`;
  return continuation ? `${head} ${continuation}` : head;
}
