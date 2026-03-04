/**
 * @fileoverview Generates a structured biomedical research plan outline.
 * Produces a multi-message prompt covering four research phases: conception,
 * data collection, analysis, and dissemination. Simplified from the legacy
 * planOrchestrator tool — delivers the plan as a reusable prompt template
 * rather than an executable tool.
 * @module src/mcp-server/prompts/definitions/research-plan.prompt
 */

import { z } from 'zod';

import type { PromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const PROMPT_NAME = 'research_plan';
const PROMPT_DESCRIPTION =
  'Generate a structured research plan outline for a biomedical research project.';

// ---------------------------------------------------------------------------
// Arguments Schema
// ---------------------------------------------------------------------------

const ArgumentsSchema = z.object({
  title: z.string().describe('Project title'),
  goal: z.string().describe('Primary research goal'),
  keywords: z.string().describe('Research keywords (comma-separated)'),
  organism: z.string().optional().describe('Target organism'),
  includeAgentPrompts: z
    .enum(['true', 'false'])
    .default('false')
    .describe('Include detailed prompts for consuming LLM'),
});

type Args = z.infer<typeof ArgumentsSchema>;

// ---------------------------------------------------------------------------
// Plan builder helpers
// ---------------------------------------------------------------------------

function agentBlock(text: string, include: boolean): string {
  return include ? `\n> **Agent guidance:** ${text}\n` : '';
}

function buildPlan(args: Args): string {
  const kw = args.keywords
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const kwList = kw.join(', ');
  const org = args.organism ?? 'Not specified';
  const ap = args.includeAgentPrompts === 'true';

  const lines: string[] = [];

  // Header
  lines.push(`# Research Plan: ${args.title}`);
  lines.push('');
  lines.push(`**Goal:** ${args.goal}`);
  lines.push(`**Keywords:** ${kwList}`);
  lines.push(`**Organism:** ${org}`);
  lines.push('');

  // Phase 1
  lines.push('---');
  lines.push('## Phase 1: Conception & Planning');
  lines.push('');
  lines.push('### 1.1 Hypothesis & Research Question');
  lines.push(`- Formulate a clear, testable hypothesis addressing: *${args.goal}*`);
  lines.push('- Identify the specific knowledge gap this research fills');
  lines.push('- Define primary and secondary research questions');
  lines.push(
    agentBlock(
      'Evaluate the hypothesis for testability and falsifiability. Consider alternative hypotheses.',
      ap,
    ),
  );
  lines.push('### 1.2 Literature Review');
  lines.push(`- Conduct a systematic search using keywords: ${kwList}`);
  lines.push('- Databases: PubMed, EMBASE, Scopus');
  lines.push('- Identify seminal papers, recent reviews, and conflicting findings');
  lines.push('- Use MeSH terms for PubMed; document search strategy for reproducibility');
  lines.push(
    agentBlock(
      'Use pubmed_search_articles and pubmed_mesh_lookup tools to build and execute the literature search.',
      ap,
    ),
  );
  lines.push('### 1.3 Experimental Design');
  lines.push('- Define experimental paradigm and study type');
  lines.push('- Plan data acquisition: existing datasets, new data generation');
  lines.push('- Specify controls (positive, negative, internal) and blinding strategy');
  lines.push('- Anticipate methodological challenges and mitigation strategies');
  lines.push('- Calculate required sample sizes for adequate statistical power');
  lines.push(
    agentBlock('Ensure the design addresses potential confounders and meets SMART criteria.', ap),
  );

  // Phase 2
  lines.push('---');
  lines.push('## Phase 2: Data Collection & Processing');
  lines.push('');
  lines.push('### 2.1 Data Collection');
  lines.push('- Wet-lab: standardize protocols, document deviations');
  lines.push('- Dry-lab: record exact queries, API parameters, tool versions');
  lines.push('- Maintain provenance tracking for all data sources');
  lines.push(agentBlock('Implement robust labeling and organization from the outset.', ap));
  lines.push('### 2.2 Quality Control & Preprocessing');
  lines.push('- Define QC metrics and acceptance thresholds');
  lines.push('- Data cleaning: outlier detection, missing value handling');
  lines.push('- Normalization and transformation appropriate for downstream analysis');
  lines.push('- Validate data quality before and after preprocessing');
  lines.push(agentBlock('Document every preprocessing step to ensure reproducibility.', ap));

  // Phase 3
  lines.push('---');
  lines.push('## Phase 3: Analysis & Interpretation');
  lines.push('');
  lines.push('### 3.1 Statistical & Computational Analysis');
  lines.push('- Select statistical tests justified by data distribution and assumptions');
  lines.push('- Apply multiple testing corrections where applicable');
  lines.push('- Bioinformatics pipeline: specify tools, parameters, and workflow');
  lines.push('- Conduct sensitivity analyses to assess robustness');
  lines.push(
    agentBlock(
      'Clearly distinguish correlation from causation. Report effect sizes alongside p-values.',
      ap,
    ),
  );
  lines.push('### 3.2 Interpretation & Contextualization');
  lines.push('- Evaluate results against the original hypothesis');
  lines.push('- Contextualize with existing literature — consistencies and discrepancies');
  lines.push('- Acknowledge limitations and their impact on conclusions');
  lines.push('- Discuss clinical or translational implications if relevant');
  lines.push(
    agentBlock(
      'Use pubmed_search_articles to find recent papers that support or contradict findings.',
      ap,
    ),
  );

  // Phase 4
  lines.push('---');
  lines.push('## Phase 4: Dissemination');
  lines.push('');
  lines.push('### 4.1 Manuscript & Data Deposition');
  lines.push('- Draft manuscript: core message, target journal, key figures/tables');
  lines.push('- Deposit data in public repositories (GEO, SRA, Zenodo) following FAIR principles');
  lines.push('- Obtain DOIs or accession numbers for all deposited data');
  lines.push(
    agentBlock(
      'Follow journal-specific author guidelines. Ensure data is de-identified if needed.',
      ap,
    ),
  );
  lines.push('### 4.2 Peer Review & Future Directions');
  lines.push('- Prepare cover letter highlighting significance and novelty');
  lines.push('- Address reviewer comments constructively, point by point');
  lines.push('- Consider preprint servers for early dissemination');
  lines.push('- Identify next steps and new questions arising from the work');
  lines.push(
    agentBlock(
      "Suggest concrete follow-up experiments based on the study's outcomes and limitations.",
      ap,
    ),
  );

  return lines.filter((l) => l !== '').join('\n');
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const researchPlanPrompt: PromptDefinition<typeof ArgumentsSchema> = {
  name: PROMPT_NAME,
  description: PROMPT_DESCRIPTION,
  argumentsSchema: ArgumentsSchema,
  generate: (args) => {
    const plan = buildPlan(args);

    return [
      {
        role: 'assistant',
        content: {
          type: 'text',
          text: [
            'You are a biomedical research planning assistant.',
            'Your role is to help researchers develop rigorous, reproducible study plans.',
            'Critically evaluate each phase for scientific soundness, feasibility, and ethical compliance.',
            'When PubMed tools are available, use them to ground recommendations in current literature.',
          ].join(' '),
        },
      },
      {
        role: 'user',
        content: {
          type: 'text',
          text: plan,
        },
      },
    ];
  },
};
