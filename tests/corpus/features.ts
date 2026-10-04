/**
 * @fileoverview The vocabulary a fixture's `meta.json` uses to say what JATS it
 * exercises. `scripts/corpus-add.ts` refuses a tag that is not listed here, so add a
 * tag before using it in a fixture.
 * @module tests/corpus/features
 */
export const FEATURES = [
  // Structure
  'nested-sections',
  'back-sections',
  'appendix',
  'boxed-text',
  'definition-list',
  'disp-quote',
  'floats-group',
  'footnotes',
  // Lists
  'lists',
  'labelled-lists',
  'ordered-lists',
  'nested-lists',
  'list-in-paragraph',
  // Front matter
  'structured-abstract',
  'multiple-abstracts',
  'abstract-list',
  'collab-author',
  'contrib-group-affiliations',
  'institution-id',
  'keywords',
  // Tables
  'tables',
  'many-tables',
  'table-spans',
  'table-footnotes',
  'table-cell-breaks',
  'table-cell-lists',
  // Math
  'inline-math',
  'display-math',
  'tex-alternatives',
  'mathml',
  // Figures and media
  'figures',
  'fig-group',
  'supplementary-material',
  // Citations and references
  'citation-xref-runs',
  'element-citation',
  'mixed-citation',
  'many-references',
  // Article types
  'research-article',
  'review',
  'case-report',
] as const;

export type Feature = (typeof FEATURES)[number];

/**
 * The vocabulary a PubMed fixture's `meta.json` uses to say what of the PubMed
 * EFetch XML (`PubmedArticle`) it exercises.
 */
export const PUBMED_FEATURES = [
  // Title and abstract
  'structured-abstract',
  'inline-markup',
  'nested-inline-markup',
  // Authors
  'collective-author',
  'mixed-author-list',
  'orcid',
  'multiple-affiliations',
  // Indexing
  'mesh-terms',
  'mesh-qualifiers',
  'keywords',
  'publication-types',
  'grants',
  // Dates and locators
  'article-date',
  'elocation-id',
  'pagination',
  // Linked notices
  'retraction',
  'erratum',
  'comment',
] as const;

export type PubmedFeature = (typeof PUBMED_FEATURES)[number];
