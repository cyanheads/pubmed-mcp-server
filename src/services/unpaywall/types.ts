/**
 * @fileoverview Types for the Unpaywall API and the content extracted from
 * open-access copies it indexes.
 * @module src/services/unpaywall/types
 */

export const UNPAYWALL_API_BASE = 'https://api.unpaywall.org/v2';

/**
 * Shape of a single OA location record returned by Unpaywall. Fields mirror
 * the public API — see https://unpaywall.org/data-format for the full contract.
 * All fields beyond `url` are best-effort.
 */
export interface UnpaywallLocation {
  /** `open`, `closed`, `embargoed`, `gold`, `hybrid`, `bronze`, `green`, etc. */
  host_type?: 'publisher' | 'repository' | string | null;
  /** SPDX-ish license identifier (`cc-by`, `cc0`, `public-domain`, …). */
  license?: string | null;
  /** Direct link to the OA copy (HTML landing page or PDF). */
  url: string;
  /** Direct link to a PDF when one is known; separate from `url`. */
  url_for_pdf?: string | null;
  /** `submittedVersion`, `acceptedVersion`, `publishedVersion`. */
  version?: 'submittedVersion' | 'acceptedVersion' | 'publishedVersion' | string | null;
}

/**
 * Subset of the Unpaywall `/v2/{doi}` response this server consumes.
 * Upstream response has many more fields — we narrow to what's actually used.
 */
export interface UnpaywallResponse {
  best_oa_location?: UnpaywallLocation | null;
  doi?: string;
  is_oa?: boolean;
  oa_locations?: UnpaywallLocation[];
  oa_status?: 'gold' | 'green' | 'hybrid' | 'bronze' | 'closed' | string;
}

/** Outcome of resolving a DOI to an OA copy. */
export type UnpaywallResolution =
  | { kind: 'found'; location: UnpaywallLocation }
  | { kind: 'no-oa'; reason: string };

/** Raw content + type tag, pre-extraction. Discriminated on `kind` so the body type narrows. */
export type UnpaywallContent =
  | { kind: 'html'; fetchedUrl: string; body: string }
  | { kind: 'pdf'; fetchedUrl: string; body: Uint8Array };

/** Kind of content body returned by a successful Unpaywall fetch. */
export type UnpaywallContentKind = UnpaywallContent['kind'];
