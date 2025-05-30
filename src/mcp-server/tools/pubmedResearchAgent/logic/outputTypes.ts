/**
 * @fileoverview Defines TypeScript types for the structured research plan outline
 * generated by the pubmed_research_agent tool. The tool primarily structures
 * client-provided inputs.
 * @module pubmedResearchAgent/logic/outputTypes
 */

// All string fields are optional as they depend on client input.
// If include_detailed_prompts_for_agent is true, these strings might be prefixed
// with a generic instruction by the planOrchestrator.

export interface Phase1Step1_1_Content {
  primary_research_question?: string;
  knowledge_gap_statement?: string;
  primary_hypothesis?: string;
  pubmed_search_strategy?: string;
  guidance_notes?: string | string[];
}
export interface Phase1Step1_2_Content {
  literature_review_scope?: string;
  key_databases_and_search_approach?: string;
  guidance_notes?: string | string[];
}
export interface Phase1Step1_3_Content {
  experimental_paradigm?: string;
  data_acquisition_plan_existing_data?: string;
  data_acquisition_plan_new_data?: string;
  blast_utilization_plan?: string;
  controls_and_rigor_measures?: string;
  methodological_challenges_and_mitigation?: string;
  guidance_notes?: string | string[];
}
export interface Phase1Output {
  title: "Phase 1: Conception and Planning";
  step_1_1_research_question_and_hypothesis: Phase1Step1_1_Content;
  step_1_2_literature_review_strategy: Phase1Step1_2_Content;
  step_1_3_experimental_design_and_data_acquisition: Phase1Step1_3_Content;
}

export interface Phase2Step2_1_Content {
  data_collection_methods_wet_lab?: string;
  data_collection_methods_dry_lab?: string;
  guidance_notes?: string | string[];
}
export interface Phase2Step2_2_Content {
  data_preprocessing_and_qc_plan?: string;
  guidance_notes?: string | string[];
}
export interface Phase2Output {
  title: "Phase 2: Data Collection and Processing";
  step_2_1_data_collection_retrieval: Phase2Step2_1_Content;
  step_2_2_data_preprocessing_and_qc: Phase2Step2_2_Content;
}

export interface Phase3Step3_1_Content {
  data_analysis_strategy?: string;
  bioinformatics_pipeline_summary?: string;
  guidance_notes?: string | string[];
}
export interface Phase3Step3_2_Content {
  results_interpretation_framework?: string;
  comparison_with_literature_plan?: string;
  guidance_notes?: string | string[];
}
export interface Phase3Output {
  title: "Phase 3: Analysis and Interpretation";
  step_3_1_data_analysis_plan: Phase3Step3_1_Content;
  step_3_2_results_interpretation: Phase3Step3_2_Content;
}

export interface Phase4Step4_1_Content {
  dissemination_manuscript_plan?: string;
  dissemination_data_deposition_plan?: string;
  guidance_notes?: string | string[];
}
export interface Phase4Step4_2_Content {
  peer_review_and_publication_approach?: string;
  guidance_notes?: string | string[];
}
export interface Phase4Step4_3_Content {
  future_research_directions?: string;
  guidance_notes?: string | string[];
}
export interface Phase4Output {
  title: "Phase 4: Dissemination and Iteration";
  step_4_1_dissemination_strategy: Phase4Step4_1_Content;
  step_4_2_peer_review_and_publication: Phase4Step4_2_Content;
  step_4_3_further_research_and_iteration: Phase4Step4_3_Content;
}

export interface CrossCuttingContent {
  record_keeping_and_data_management?: string;
  collaboration_strategy?: string;
  ethical_considerations?: string;
  guidance_notes?: string | string[];
}
export interface CrossCuttingOutput {
  title: "Cross-Cutting Considerations";
  content: CrossCuttingContent;
}

export interface PubMedResearchPlanGeneratedOutput {
  plan_title: string;
  overall_instructions_for_research_agent?: string;
  input_summary: {
    keywords_received: string[];
    primary_goal_stated_or_inferred: string;
    organism_focus?: string; // Ensured this is present
    included_detailed_prompts_for_agent: boolean; // Renamed from included_challenges_consideration for clarity
  };
  phase_1_conception_and_planning: Phase1Output;
  phase_2_data_collection_and_processing: Phase2Output;
  phase_3_analysis_and_interpretation: Phase3Output;
  phase_4_dissemination_and_iteration: Phase4Output;
  cross_cutting_considerations: CrossCuttingOutput;
}
