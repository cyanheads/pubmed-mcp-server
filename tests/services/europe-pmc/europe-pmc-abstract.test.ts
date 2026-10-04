/**
 * @fileoverview Europe PMC's `fullTextXML` reaches the abstract through the same
 * `parsePmcArticle` the PMC tier uses, so an abstract paragraph beside a
 * `<sec>` survives on that tier too. (#204)
 * @module tests/services/europe-pmc/europe-pmc-abstract.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EuropePmcApiClient } from '@/services/europe-pmc/api-client.js';
import { EuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
import { createEuropePmcRequestQueue } from '@/services/europe-pmc/request-queue.js';
import { parsePmcArticle } from '@/services/ncbi/parsing/pmc-article-parser.js';

describe('EuropePmcService.parseFullTextXml abstract (#204)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
  });

  it('keeps the direct paragraph of an abstract that also holds a section (PMC11281965)', () => {
    const service = new EuropePmcService(
      new EuropePmcApiClient({ timeoutMs: 20000 }),
      createEuropePmcRequestQueue(0),
      0,
    );
    const node = service.parseFullTextXml(
      `<?xml version="1.0" encoding="UTF-8"?>
<article><front><article-meta><article-id pub-id-type="pmcid">PMC11281965</article-id>
<abstract id="Abs1"><p id="Par1">Sepsis is characterized by a metabolic disorder of amino acid occurs in the early stage.</p><sec><title>Supplementary Information</title><p>The online version contains supplementary material available at 10.1007/s00726-024-03408-3.</p></sec></abstract>
</article-meta></front><body><sec><title>Introduction</title><p>Sepsis is commonly encountered.</p></sec></body></article>`,
    );
    if (!node) throw new Error('expected an <article> node');

    expect(parsePmcArticle(node).abstract).toBe(
      'Sepsis is characterized by a metabolic disorder of amino acid occurs in the early stage.\n\n' +
        'Supplementary Information: The online version contains supplementary material available at 10.1007/s00726-024-03408-3.',
    );
  });
});
