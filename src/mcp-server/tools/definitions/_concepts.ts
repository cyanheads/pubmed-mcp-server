/**
 * @fileoverview Ontology-backed semantic concept identifiers attached to each
 * tool's `_meta['io.mcpmed/concepts']` field. Each constant is a stable URI
 * from an established vocabulary (Schema.org or EDAM) paired with a human
 * label — no free-text placeholders.
 *
 * This implements the semantic concept mapping proposed in MCPmed
 * (Flotho et al., Briefings in Bioinformatics, 2026; doi:10.1093/bib/bbag076)
 * with resolvable URIs rather than the placeholder strings used in that paper's
 * reference implementations.
 *
 * Namespacing: the `io.mcpmed/concepts` key is a proposal for MCPmed-aligned
 * servers. If MCPmed standardizes a different key, this is a single rename.
 *
 * @module src/mcp-server/tools/definitions/_concepts
 */

/** A single ontology-backed concept tag. */
export interface ConceptTag {
  readonly id: string;
  readonly label: string;
}

// Schema.org — generic web entities and actions.
export const SCHEMA_SEARCH_ACTION: ConceptTag = {
  id: 'https://schema.org/SearchAction',
  label: 'Search action',
};
export const SCHEMA_SCHOLARLY_ARTICLE: ConceptTag = {
  id: 'https://schema.org/ScholarlyArticle',
  label: 'Scholarly article',
};
export const SCHEMA_CREATIVE_WORK: ConceptTag = {
  id: 'https://schema.org/CreativeWork',
  label: 'Creative work',
};
export const SCHEMA_DEFINED_TERM: ConceptTag = {
  id: 'https://schema.org/DefinedTerm',
  label: 'Defined term',
};
export const SCHEMA_DEFINED_TERM_SET: ConceptTag = {
  id: 'https://schema.org/DefinedTermSet',
  label: 'Defined term set',
};

// EDAM ontology — bioinformatics operations, data, and topics.
export const EDAM_DATABASE_SEARCH: ConceptTag = {
  id: 'https://edamontology.org/operation_2421',
  label: 'Database search',
};
export const EDAM_DATA_RETRIEVAL: ConceptTag = {
  id: 'https://edamontology.org/operation_2422',
  label: 'Data retrieval',
};
export const EDAM_ID_MAPPING: ConceptTag = {
  id: 'https://edamontology.org/operation_3282',
  label: 'ID mapping',
};
export const EDAM_DATA_FORMATTING: ConceptTag = {
  id: 'https://edamontology.org/operation_0335',
  label: 'Data formatting',
};
export const EDAM_ONTOLOGY_TERMINOLOGY: ConceptTag = {
  id: 'https://edamontology.org/topic_0089',
  label: 'Ontology and terminology',
};
export const EDAM_PUBMED_ID: ConceptTag = {
  id: 'https://edamontology.org/data_1187',
  label: 'PubMed ID',
};
export const EDAM_ACCESSION: ConceptTag = {
  id: 'https://edamontology.org/data_2091',
  label: 'Accession',
};

/**
 * Builds the `_meta` payload emitted alongside each tool definition.
 * Kept as a helper so the key namespace is declared exactly once.
 */
export function conceptMeta(concepts: readonly ConceptTag[]): {
  'io.mcpmed/concepts': readonly ConceptTag[];
} {
  return { 'io.mcpmed/concepts': concepts };
}
