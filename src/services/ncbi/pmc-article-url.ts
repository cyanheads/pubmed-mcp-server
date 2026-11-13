/**
 * @fileoverview The PMC article page URL, on PMC's current host. Every `pmcUrl` a tool
 * returns and the RIS export's PMC `UR` line are built here, so one article's PMC link
 * reads the same across tools.
 * @module src/services/ncbi/pmc-article-url
 */

/**
 * PMC article page for a `PMC<digits>` ID. The article path on PMC's legacy host
 * (`www.ncbi.nlm.nih.gov`) answers HTTP 301 to this one.
 */
export function pmcArticleUrl(pmcId: string): string {
  return `https://pmc.ncbi.nlm.nih.gov/articles/${pmcId}/`;
}
