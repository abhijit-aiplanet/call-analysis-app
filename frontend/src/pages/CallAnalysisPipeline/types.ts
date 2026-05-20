// Shared TypeScript types for the Call Analysis Pipeline (Scribe v2 + multi-agent).

// ─── Per-call result types ──────────────────────────────────────────────────
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

export interface SentimentAggregate {
  specialists: {
    intelligence: SpecialistEntry;
    emotion: SpecialistEntry;
    performance: SpecialistEntry;
    resolution: SpecialistEntry;
    risk: SpecialistEntry;
  };
  synthesizer: SpecialistEntry;
  aggregate_cost: {
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    total_cost_usd: number;
    specialists_total_usd: number;
    synthesizer_usd: number;
    n_specialists: number;
  };
  timing: {
    specialists_parallel_wall_s: number;
    synthesizer_wall_s: number;
    total_sentiment_wall_s: number;
  };
  ran_at_utc: string;
  model: string;
}

export interface UnifiedCost {
  stt_usd: number;
  sentiment_usd: number;
  specialists_usd: number;
  synthesizer_usd: number;
  total_usd: number;
  cost_per_minute_audio_usd: number | null;
  total_wall_time_s: number;
  stage_cost_share_pct: { stt: number; sentiment: number };
  rate_card: Record<string, number>;
}

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

export interface AnalysisRecord {
  filename: string;
  processed_at_utc: string;
  audio_meta: AudioMeta;
  stage_1_stt: {
    vendor: string;
    model_id: string;
    raw_full_text: string | null;
    utterances: STTUtterance[];
    cost: STTCost;
  };
  stage_2_sentiment_multi_agent: SentimentAggregate;
  unified_cost: UnifiedCost;
}

// ─── Single-file response (legacy /analyze endpoint) ────────────────────────
export interface AnalyzeResponse {
  success: boolean;
  result?: AnalysisRecord;
  error?: string;
}

// ─── Batch job types (new /batch endpoints) ─────────────────────────────────
export type FileStatus =
  | "queued"
  | "running_stt"
  | "running_sentiment"
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
  total_sentiment_usd: number;
  total_pipeline_usd: number;
  avg_cost_per_call_usd: number;
  avg_cost_per_minute_audio_usd: number | null;
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
