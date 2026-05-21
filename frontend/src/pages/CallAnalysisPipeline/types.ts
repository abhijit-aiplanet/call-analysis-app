// Shared TypeScript types for the RCU AI Verification pipeline.

// ─── STT layer ──────────────────────────────────────────────────────────────
export interface STTUtterance {
  speaker: string | null;
  text: string;
  start_s: number | null;
  end_s: number | null;
}

export interface STTCost {
  audio_seconds: number;
  audio_minutes: number;
  audio_hours: number;
  rate_per_hour_base: number;
  rate_per_hour_keyterms: number;
  rate_per_hour_total: number;
  cost_usd_base: number;
  cost_usd_keyterms: number;
  cost_usd_total: number;
  keyterms_used: string[];
  wall_time_s: number;
}

// ─── LLM agent cost ─────────────────────────────────────────────────────────
export interface LLMCost {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd_input: number;
  cost_usd_output: number;
  cost_usd_total: number;
  wall_time_s?: number;
}

export interface SpecialistEntry {
  output: Record<string, unknown>;
  cost: LLMCost;
}

// ─── Triage + Reflection agent blocks ──────────────────────────────────────
export interface TriageOutput {
  needs_full_pipeline: boolean;
  quick_disposition: string | null;
  quick_verdict: RCUVerdict | null;
  quick_routing: DecisionRouting | null;
  quick_confidence_1_10: number | null;
  rationale: string;
}

export interface TriageBlock {
  output: TriageOutput;
  cost: LLMCost;
  short_circuited: boolean;
}

export interface ReflectionIssue {
  severity: "low" | "medium" | "high" | string;
  check: string;
  description: string;
}

export interface ReflectionOutput {
  issues_found: ReflectionIssue[];
  agreement_with_decision: "full" | "partial" | "disagree" | string;
  confidence_delta: number;
  disposition_override_suggestion: string | null;
  routing_override: DecisionRouting | null;
  reviewer_notes: string;
}

export interface ReflectionBlock {
  output: ReflectionOutput | null;
  cost: LLMCost;
  applied: boolean;
}

// ─── Multi-agent verification stage ────────────────────────────────────────
export interface VerificationAggregate {
  triage?: TriageBlock;
  specialists: {
    information_extraction?: SpecialistEntry;
    identity_verification?:  SpecialistEntry;
    fraud_risk?:             SpecialistEntry;
    conversation_behavior?:  SpecialistEntry;
  };
  decision_agent: SpecialistEntry;
  reflection?: ReflectionBlock;
  final_output?: Record<string, unknown>;
  aggregate_cost: {
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    total_cost_usd: number;
    triage_usd?: number;
    specialists_total_usd: number;
    decision_agent_usd: number;
    reflection_usd?: number;
    n_specialists: number;
  };
  timing: {
    triage_wall_s?: number;
    specialists_parallel_wall_s: number;
    decision_agent_wall_s: number;
    reflection_wall_s?: number;
    total_verification_wall_s: number;
  };
  ran_at_utc: string;
  model: string;
}

// ─── Unified cost summary ──────────────────────────────────────────────────
export interface UnifiedCost {
  stt_usd: number;
  verification_usd: number;
  triage_usd?: number;
  specialists_usd: number;
  decision_agent_usd: number;
  reflection_usd?: number;
  total_usd: number;
  cost_per_minute_audio_usd: number | null;
  total_wall_time_s: number;
  stage_cost_share_pct: { stt: number; verification: number };
  rate_card: Record<string, number>;
}

// ─── Audio metadata ────────────────────────────────────────────────────────
export interface AudioMeta {
  audio_duration_s: number;
  audio_minutes: number;
  language_code: string | null;
  language_probability: number | null;
  num_speakers: number;
  num_utterances: number;
  transcription_id: string | null;
  keyterms_applied: string[];
}

// ─── Top-level RCU verdict (the headline) ──────────────────────────────────
export type RCUVerdict = "Critical" | "Negative" | "Positive" | string;
export type RCUStatus  = "Critical" | "Negative" | "Positive" | string;
export type CallerType = "Applicant" | "Co-applicant" | "Monnai" | "Unknown" | string;
export type DecisionRouting = "auto_clear" | "human_qc" | "compliance_escalation" | string;

export interface EvidenceQuote {
  tag: string;
  quote: string;
  timestamp_s: number | null;
}

export interface RCUVerdictBlock {
  verdict: RCUVerdict | null;
  verdict_confidence_1_10: number | null;
  disposition: string | null;
  disposition_rcu_status: RCUStatus | null;
  caller_type: CallerType | null;
  decision_routing: DecisionRouting | null;
  routing_rationale: string | null;
  headline_chip: string | null;
  executive_summary: string | null;
  rationale: string | null;
  risk_tags: string[];
  key_evidence_quotes: EvidenceQuote[];
  reasoning_chain?: string[];
  disposition_override_suggestion?: string | null;
  triage_short_circuit?: boolean;
  reflection_applied?: boolean;
  pre_reflection?: {
    verdict_confidence_1_10: number | null;
    decision_routing: DecisionRouting | null;
  } | null;
}

// ─── Full per-call record ──────────────────────────────────────────────────
export interface AnalysisRecord {
  filename: string;
  processed_at_utc: string;
  audio_meta: AudioMeta;
  rcu_verdict: RCUVerdictBlock;
  stage_1_stt: {
    vendor: string;
    model_id: string;
    raw_full_text: string | null;
    utterances: STTUtterance[];
    cost: STTCost;
  };
  stage_2_verification: VerificationAggregate;
  unified_cost: UnifiedCost;
}

// ─── Single-file endpoint response ─────────────────────────────────────────
export interface AnalyzeResponse {
  success: boolean;
  result?: AnalysisRecord;
  error?: string;
}

// ─── Batch types ───────────────────────────────────────────────────────────
export type FileStatus =
  | "queued"
  | "running_stt"
  | "running_sentiment"   // kept name for back-compat with batch_manager
  | "ok"
  | "error";

export type BatchJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed";

export interface BatchFileEntry {
  filename: string;
  file_size_bytes: number;
  status: FileStatus;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  error_type: string | null;
  result: AnalysisRecord | null;
  wall_time_s: number | null;
}

export interface BatchAggregateCost {
  total_files: number;
  completed_files: number;
  failed_files: number;
  total_audio_seconds: number;
  total_audio_minutes: number;
  total_audio_hours: number;
  total_stt_usd: number;
  total_verification_usd: number;
  total_pipeline_usd: number;
  avg_cost_per_call_usd: number;
  avg_cost_per_minute_audio_usd: number | null;
  verdict_distribution: Record<string, number>;
  wall_time_seconds: number;
  audio_minutes_per_wall_minute?: number;
}

export interface BatchJob {
  job_id: string;
  status: BatchJobStatus;
  keyterms: string[];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  file_count: number;
  completed_count: number;
  failed_count: number;
  running_count: number;
  queued_count: number;
  progress_pct: number;
  files: BatchFileEntry[];
  aggregate_cost: BatchAggregateCost | null;
}

export interface BatchCreateResponse {
  job_id: string;
  status: BatchJobStatus;
  file_count: number;
  keyterms: string[];
  concurrency: {
    files_in_flight: number;
    max_concurrent_batches: number;
  };
}

// ─── Disposition color/tone mapping (for badges) ──────────────────────────
export const VERDICT_TONE: Record<string, { bg: string; text: string; border: string }> = {
  Critical: { bg: "bg-red-100",     text: "text-red-700",     border: "border-red-200" },
  Negative: { bg: "bg-amber-100",   text: "text-amber-700",   border: "border-amber-200" },
  Positive: { bg: "bg-emerald-100", text: "text-emerald-700", border: "border-emerald-200" },
  Unknown:  { bg: "bg-slate-100",   text: "text-slate-600",   border: "border-slate-200" },
};

export const ROUTING_TONE: Record<string, { bg: string; text: string; label: string }> = {
  auto_clear:               { bg: "bg-emerald-100", text: "text-emerald-800", label: "Auto-cleared" },
  human_qc:                 { bg: "bg-amber-100",   text: "text-amber-800",   label: "Routed to human QC" },
  compliance_escalation:    { bg: "bg-red-100",     text: "text-red-800",     label: "Compliance escalation" },
};
