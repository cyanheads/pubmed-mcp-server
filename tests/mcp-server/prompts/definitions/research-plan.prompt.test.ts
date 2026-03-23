/**
 * @fileoverview Tests for the research-plan prompt.
 * @module tests/mcp-server/prompts/definitions/research-plan.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { researchPlanPrompt } from '@/mcp-server/prompts/definitions/research-plan.prompt.js';

describe('researchPlanPrompt', () => {
  it('validates args schema', () => {
    const args = researchPlanPrompt.args.parse({
      title: 'Gene Therapy Study',
      goal: 'Evaluate CRISPR efficacy',
      keywords: 'CRISPR, gene therapy, oncology',
    });
    expect(args.title).toBe('Gene Therapy Study');
    expect(args.includeAgentPrompts).toBe('false');
  });

  it('generates a multi-message prompt', () => {
    const messages = researchPlanPrompt.generate({
      title: 'My Study',
      goal: 'Test hypothesis X',
      keywords: 'alpha, beta',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[1]?.role).toBe('user');
  });

  it('includes all 4 research phases in the plan', () => {
    const messages = researchPlanPrompt.generate({
      title: 'Study',
      goal: 'Goal',
      keywords: 'kw1, kw2',
    });

    const planText = messages[1]?.content.text ?? '';
    expect(planText).toContain('Phase 1');
    expect(planText).toContain('Phase 2');
    expect(planText).toContain('Phase 3');
    expect(planText).toContain('Phase 4');
    expect(planText).toContain('Literature Review');
    expect(planText).toContain('Data Collection');
    expect(planText).toContain('Analysis');
    expect(planText).toContain('Dissemination');
  });

  it('includes agent prompts when requested', () => {
    const messages = researchPlanPrompt.generate({
      title: 'Study',
      goal: 'Goal',
      keywords: 'kw',
      includeAgentPrompts: 'true',
    });

    const planText = messages[1]?.content.text ?? '';
    expect(planText).toContain('Agent guidance');
  });

  it('excludes agent prompts by default', () => {
    const messages = researchPlanPrompt.generate({
      title: 'Study',
      goal: 'Goal',
      keywords: 'kw',
    });

    const planText = messages[1]?.content.text ?? '';
    expect(planText).not.toContain('Agent guidance');
  });

  it('includes organism when provided', () => {
    const messages = researchPlanPrompt.generate({
      title: 'Study',
      goal: 'Goal',
      keywords: 'kw',
      organism: 'Homo sapiens',
    });

    const planText = messages[1]?.content.text ?? '';
    expect(planText).toContain('Homo sapiens');
  });

  it('shows "Not specified" when organism is omitted', () => {
    const messages = researchPlanPrompt.generate({
      title: 'Study',
      goal: 'Goal',
      keywords: 'kw',
    });

    const planText = messages[1]?.content.text ?? '';
    expect(planText).toContain('Not specified');
  });
});
