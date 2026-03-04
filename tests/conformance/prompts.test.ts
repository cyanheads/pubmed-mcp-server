/**
 * @fileoverview Prompt protocol conformance tests.
 * Validates prompt listing, argument schema advertisement, and prompt generation
 * through the full protocol stack.
 * @module tests/conformance/prompts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ConformanceHarness, createConformanceHarness } from './helpers/server-harness.js';

describe('Prompt protocol conformance', () => {
  let harness: ConformanceHarness;

  beforeAll(async () => {
    harness = await createConformanceHarness();
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  // ── Listing ──────────────────────────────────────────────────────────────

  describe('listPrompts', () => {
    it('returns a non-empty prompts array', async () => {
      const result = await harness.client.listPrompts();
      expect(result.prompts).toBeDefined();
      expect(result.prompts.length).toBeGreaterThanOrEqual(1);
    });

    it('each prompt has name and description', async () => {
      const { prompts } = await harness.client.listPrompts();
      for (const prompt of prompts) {
        expect(prompt.name).toBeTruthy();
        expect(typeof prompt.name).toBe('string');
        expect(prompt.description).toBeTruthy();
      }
    });

    it('includes the research_plan prompt', async () => {
      const { prompts } = await harness.client.listPrompts();
      const researchPlan = prompts.find((p) => p.name === 'research_plan');
      expect(researchPlan).toBeDefined();
    });

    it('research_plan prompt advertises arguments', async () => {
      const { prompts } = await harness.client.listPrompts();
      const researchPlan = prompts.find((p) => p.name === 'research_plan')!;
      expect(researchPlan.arguments).toBeDefined();
      expect(Array.isArray(researchPlan.arguments)).toBe(true);
      expect(researchPlan.arguments?.length).toBeGreaterThan(0);

      const argNames = researchPlan.arguments?.map((a) => a.name);
      expect(argNames).toContain('title');
      expect(argNames).toContain('goal');
      expect(argNames).toContain('keywords');
    });
  });

  // ── Generation ────────────────────────────────────────────────────────────

  describe('getPrompt', () => {
    it('generates messages with required arguments', async () => {
      const result = await harness.client.getPrompt({
        name: 'research_plan',
        arguments: {
          title: 'Test Research Project',
          goal: 'Evaluate conformance test coverage',
          keywords: 'testing, conformance',
        },
      });

      expect(result.messages).toBeDefined();
      expect(result.messages.length).toBeGreaterThan(0);
      // First message is the system/assistant preamble
      expect(result.messages[0]?.role).toBe('assistant');
      expect(result.messages[0]?.content).toBeDefined();
    });

    it('includes project title in generated plan', async () => {
      const result = await harness.client.getPrompt({
        name: 'research_plan',
        arguments: {
          title: 'Conformance Test Project',
          goal: 'Validate protocol behavior',
          keywords: 'mcp, protocol',
        },
      });

      // The user message contains the plan text
      const userMsg = result.messages.find((m) => m.role === 'user');
      expect(userMsg).toBeDefined();
      const content = userMsg?.content;
      if (typeof content === 'object' && 'text' in content) {
        expect(content.text).toContain('Conformance Test Project');
      }
    });

    it('includes keywords in generated plan', async () => {
      const result = await harness.client.getPrompt({
        name: 'research_plan',
        arguments: {
          title: 'Keyword Test',
          goal: 'Test keyword inclusion',
          keywords: 'oncology, immunotherapy',
        },
      });

      const userMsg = result.messages.find((m) => m.role === 'user');
      const content = userMsg?.content;
      if (typeof content === 'object' && 'text' in content) {
        expect(content.text).toContain('oncology');
        expect(content.text).toContain('immunotherapy');
      }
    });

    it('rejects unknown prompt name', async () => {
      await expect(
        harness.client.getPrompt({
          name: 'nonexistent_prompt_abc123',
        }),
      ).rejects.toThrow();
    });
  });
});
