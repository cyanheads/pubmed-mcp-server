/**
 * @fileoverview The linked-notice block `pubmed_format_citations` and
 * `pubmed_fetch_articles` both open a record with: the retraction, erratum, and
 * expression-of-concern links NCBI attaches to it, under a warning when one is a
 * retraction. (#215, #237)
 * @module src/mcp-server/tools/definitions/_notices
 */

import {
  CITATION_NOTICE_TYPES,
  type CitationNoticeType,
} from '@/services/ncbi/formatting/citation-formatter.js';
import { escapeMarkdownInline } from './_text.js';

/** One NCBI comments-and-corrections link as a tool's output carries it. */
interface NoticeLink {
  note?: string | undefined;
  pmid?: string | undefined;
  refSource: string;
  refType: string;
}

const NOTICE_TYPES: ReadonlySet<string> = new Set(CITATION_NOTICE_TYPES);

/**
 * The links that qualify the record itself — it was retracted, corrected, or
 * questioned — in NCBI's order. Comment, update, and `…Of`/`…For` links, which
 * point from a notice back to what it concerns, are not among them.
 */
export function noticeLinks<T extends NoticeLink>(
  links: readonly T[] | undefined,
): (T & { refType: CitationNoticeType })[] {
  return (links ?? []).filter((link): link is T & { refType: CitationNoticeType } =>
    NOTICE_TYPES.has(link.refType),
  );
}

/**
 * The `content[]` lines for one record's notices, opening on a warning when it
 * was retracted. Each entry takes the form the record's full "Comments and
 * Corrections" list gives the same link.
 */
export function noticeLines(
  notices: readonly (NoticeLink & { refType: CitationNoticeType })[],
): string[] {
  const retracted = notices.some(
    (notice) => notice.refType === 'RetractionIn' || notice.refType === 'RetractedandRepublishedIn',
  );
  return [
    retracted ? '**Retracted:** NCBI links a retraction notice to this article.' : '**Notices:**',
    ...notices.map((notice) => {
      const pmid = notice.pmid ? ` — PMID ${notice.pmid}` : '';
      const note = notice.note ? ` — Note: ${escapeMarkdownInline(notice.note)}` : '';
      return `- **${notice.refType}:** ${escapeMarkdownInline(notice.refSource)}${pmid}${note}`;
    }),
  ];
}
