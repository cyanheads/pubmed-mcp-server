/**
 * @fileoverview Tests for the Europe PMC hit rules both Europe PMC tools share:
 * full-text availability, `epmcFullTextId()`, which the Europe PMC tier of
 * `pubmed_fetch_fulltext` also uses, and the journal name, `epmcJournal()`.
 * The tools' own suites prove only their wiring.
 * @module tests/services/europe-pmc/types.test
 */

import { describe, expect, it } from 'vitest';

import {
  type EuropePmcSearchHit,
  epmcFullTextId,
  epmcJournal,
} from '@/services/europe-pmc/types.js';

const ids = (...fullTextId: string[]) => ({ fullTextIdList: { fullTextId } });

describe('epmcFullTextId', () => {
  /**
   * `inPMC` and `inEPMC` are set opposite to the answer on every row they
   * appear on: across a 68-record sample, both disagreed with whether
   * `fullTextXML` existed in each direction, and only `isOpenAccess` matched it.
   */
  it.each<[string, Partial<EuropePmcSearchHit>, string | undefined]>([
    [
      'an open-access preprint, by its own accession',
      { id: 'PPR1325930', source: 'PPR', isOpenAccess: 'Y', inPMC: 'N', ...ids('PPR1325930') },
      'PPR1325930',
    ],
    [
      'an open-access preprint Europe PMC does not mark in EPMC',
      { id: 'PPR9', source: 'PPR', isOpenAccess: 'Y', inEPMC: 'N', ...ids('PPR9') },
      'PPR9',
    ],
    [
      'an open-access MED record, by its PMCID',
      { id: '42', source: 'MED', pmcid: 'PMC42', isOpenAccess: 'Y', ...ids('PMC42') },
      'PMC42',
    ],
    [
      'a PMC deposit outside the open-access subset',
      {
        id: '42684012',
        source: 'MED',
        pmcid: 'PMC13536919',
        isOpenAccess: 'N',
        inPMC: 'Y',
        ...ids('PMC13536919'),
      },
      undefined,
    ],
    [
      'a preprint outside the open-access subset',
      { id: 'PPR7', source: 'PPR', isOpenAccess: 'N', inEPMC: 'Y', ...ids('PPR7') },
      undefined,
    ],
    [
      'an open-access record that lists no full-text id',
      { id: '43', source: 'MED', pmcid: 'PMC43', isOpenAccess: 'Y', inPMC: 'Y' },
      undefined,
    ],
    [
      'an open-access record whose full-text id list is empty',
      { id: '44', source: 'MED', pmcid: 'PMC44', isOpenAccess: 'Y', ...ids() },
      undefined,
    ],
    [
      'a record Europe PMC reports no open-access status for',
      { id: '45', source: 'MED', pmcid: 'PMC45', inPMC: 'Y', ...ids('PMC45') },
      undefined,
    ],
  ])('%s', (_label, hit, expected) => {
    expect(epmcFullTextId(hit as EuropePmcSearchHit)).toBe(expected);
  });
});

describe('epmcJournal', () => {
  /** `journalInfo.journal` as a `core` result carries it. */
  const journal = (fields: Record<string, string>) => ({ journalInfo: { journal: fields } });

  /**
   * Rows mirror captured `core` and `lite` results for the same records: across
   * 300 records (100 MED, 100 PMC, 52 AGR, 48 PPR), `lite`'s `journalTitle`
   * equalled `medlineAbbreviation`, else `title`, on every one, while
   * `isoabbreviation` is absent on AGR records and `title` is the full name on
   * MED and PMC ones.
   */
  it.each<[string, Partial<EuropePmcSearchHit>, string | undefined]>([
    [
      'a lite result, by its journalTitle',
      { id: '42515993', source: 'MED', journalTitle: 'Otolaryngol Pol' },
      'Otolaryngol Pol',
    ],
    [
      'a core MED result, by its MEDLINE abbreviation rather than the full title',
      {
        id: '42515993',
        source: 'MED',
        ...journal({
          medlineAbbreviation: 'Otolaryngol Pol',
          title: 'Otolaryngologia polska = The Polish otolaryngology',
          isoabbreviation: 'Otolaryngol Pol',
        }),
      },
      'Otolaryngol Pol',
    ],
    [
      'a core AGR result whose MEDLINE abbreviation is cased apart from its title',
      {
        id: 'IND609457914',
        source: 'AGR',
        ...journal({
          medlineAbbreviation: 'Journal of phytopathology.',
          title: 'Journal of Phytopathology',
        }),
      },
      'Journal of phytopathology.',
    ],
    [
      'a core AGR result with no abbreviation, by its title',
      { id: 'IND608907408', source: 'AGR', ...journal({ title: 'Heliyon' }) },
      'Heliyon',
    ],
    [
      'a preprint, which carries no journal on either result type',
      { id: 'PPR1', source: 'PPR' },
      undefined,
    ],
    [
      'a journalInfo block with no journal in it',
      { id: '1', source: 'MED', journalInfo: {} },
      undefined,
    ],
    [
      'an empty MEDLINE abbreviation, by the title',
      { id: '2', source: 'AGR', ...journal({ medlineAbbreviation: '', title: 'Plant Science.' }) },
      'Plant Science.',
    ],
  ])('%s', (_label, hit, expected) => {
    expect(epmcJournal(hit as EuropePmcSearchHit)).toBe(expected);
  });
});
