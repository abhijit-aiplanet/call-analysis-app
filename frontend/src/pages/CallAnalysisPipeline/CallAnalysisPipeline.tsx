import { useEffect, useRef, useState } from "react";
import Layout from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sparkles, MessageSquare, ListChecks, Tag, ArrowLeft,
  FileText, Brain, Heart, Users, ShieldAlert, DollarSign,
} from "lucide-react";

import { createBatch, getBatch } from "./api";
import type { BatchJob, BatchFileEntry, AnalysisRecord } from "./types";
import { BatchUploader } from "./BatchUploader";
import { BatchProgress } from "./BatchProgress";
import { BatchSummary } from "./BatchSummary";
import { FileSelector } from "./FileSelector";
import { CostBreakdown } from "./CostBreakdown";
import { IntelligenceView } from "./views/IntelligenceView";
import { EmotionView } from "./views/EmotionView";
import { PerformanceView } from "./views/PerformanceView";
import { ResolutionView } from "./views/ResolutionView";
import { RiskView } from "./views/RiskView";

type PageState = "uploading" | "submitting" | "processing" | "done";

const CallAnalysisPipeline = () => {
  const [pageState, setPageState] = useState<PageState>("uploading");
  const [job, setJob] = useState<BatchJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFileIdx, setSelectedFileIdx] = useState(0);
  const [activeTab, setActiveTab] = useState("summary");
  const pollIntervalRef = useRef<number | null>(null);

  // Polling effect
  useEffect(() => {
    if (!job || pageState === "done") return;
    if (job.status === "completed" || job.status === "completed_with_errors" || job.status === "failed") {
      setPageState("done");
      // pick first OK file
      const firstOk = job.files.findIndex((f) => f.status === "ok");
      if (firstOk >= 0) setSelectedFileIdx(firstOk);
      return;
    }
    pollIntervalRef.current = window.setTimeout(async () => {
      try {
        const updated = await getBatch(job.job_id);
        setJob(updated);
      } catch (e) {
        console.error("poll error:", e);
      }
    }, 2000) as unknown as number;
    return () => {
      if (pollIntervalRef.current) {
        clearTimeout(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [job, pageState]);

  const handleSubmit = async (files: File[], keyterms: string[]) => {
    setPageState("submitting");
    setError(null);
    try {
      const resp = await createBatch(files, keyterms);
      // immediately fetch the initial job state
      const initial = await getBatch(resp.job_id);
      setJob(initial);
      setPageState("processing");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to submit batch";
      setError(msg);
      setPageState("uploading");
    }
  };

  const handleReset = () => {
    setJob(null);
    setError(null);
    setSelectedFileIdx(0);
    setActiveTab("summary");
    setPageState("uploading");
  };

  const selectedFile: BatchFileEntry | null = job?.files[selectedFileIdx] ?? null;
  const selectedResult: AnalysisRecord | null = selectedFile?.result ?? null;
  const syn = selectedResult?.stage_2_sentiment_multi_agent.synthesizer.output as Record<string, unknown> | undefined;

  return (
    <Layout
      title="Call Analysis Pipeline"
      description="ElevenLabs Scribe v2 STT (code-mixed Indian-language transcripts, with diarization) + 6-agent system + granular per-stage cost tracking. Upload one call or batch up to 50."
      category="Financial Banking"
    >
      <div className="space-y-6 font-inter">
        {/* Stage: uploading / submitting */}
        {(pageState === "uploading" || pageState === "submitting") && (
          <BatchUploader
            onSubmit={handleSubmit}
            isSubmitting={pageState === "submitting"}
            error={error}
          />
        )}

        {/* Stage: processing or done */}
        {(pageState === "processing" || pageState === "done") && job && (
          <>
            {/* Header strip with reset */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                {job.keyterms.length > 0 && (
                  <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200 font-normal">
                    <Tag className="size-3 mr-1" />
                    {job.keyterms.length} keyterm{job.keyterms.length !== 1 ? "s" : ""}
                  </Badge>
                )}
                <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200 font-normal text-[10px]">
                  Concurrency: {/* this is fine to hardcode shown */} 5 files in flight
                </Badge>
              </div>
              <Button variant="outline" size="sm" onClick={handleReset} className="h-8">
                <ArrowLeft className="size-3.5 mr-1.5" />
                New Batch
              </Button>
            </div>

            {/* Always show progress (during) or summary (after) */}
            {pageState === "processing" && <BatchProgress job={job} />}

            {pageState === "done" && job.aggregate_cost && (
              <BatchSummary job={job} />
            )}

            {/* Once we have at least one ok file, show per-file selector + details */}
            {job.files.some((f) => f.status === "ok") && (
              <>
                <FileSelector
                  files={job.files}
                  selectedIdx={selectedFileIdx}
                  onSelect={(i) => { setSelectedFileIdx(i); setActiveTab("summary"); }}
                />

                {selectedResult && syn && (
                  <PerFileDetail
                    result={selectedResult}
                    activeTab={activeTab}
                    setActiveTab={setActiveTab}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </Layout>
  );
};

// ─── Per-file detail view ──────────────────────────────────────────────────
interface PerFileDetailProps {
  result: AnalysisRecord;
  activeTab: string;
  setActiveTab: (t: string) => void;
}

const PerFileDetail = ({ result, activeTab, setActiveTab }: PerFileDetailProps) => {
  const syn = result.stage_2_sentiment_multi_agent.synthesizer.output as Record<string, unknown>;
  const specs = result.stage_2_sentiment_multi_agent.specialists;
  const tag = syn?.one_line_call_tag as string | undefined;
  const headline = syn?.headline_metrics as Record<string, unknown> | undefined;
  const execSummary = syn?.executive_summary as string | undefined;

  return (
    <div className="space-y-4">
      {/* Headline tag */}
      <Card className="rounded-2xl border-emerald-200/70 bg-gradient-to-br from-emerald-50/40 to-white">
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
          <Sparkles className="size-5 text-emerald-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-medium text-emerald-700 uppercase tracking-wider">Call Tag</div>
            <div className="text-base font-semibold text-slate-900">{tag || "—"}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <Badge variant="outline" className="bg-white font-mono">
              {result.audio_meta.language_code}
              {result.audio_meta.language_probability != null && (
                <span className="ml-1 text-slate-400">
                  {(result.audio_meta.language_probability * 100).toFixed(0)}%
                </span>
              )}
            </Badge>
            <Badge variant="outline" className="bg-white">
              {result.audio_meta.audio_duration_s.toFixed(0)}s · {result.audio_meta.num_speakers} speakers
            </Badge>
            <Badge variant="outline" className="bg-white font-mono">
              ${result.unified_cost.total_usd.toFixed(4)}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-slate-100/60 p-1 rounded-xl">
          <TabsTrigger value="summary" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <FileText className="size-3.5 mr-1.5" /> Summary
          </TabsTrigger>
          <TabsTrigger value="intel" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <Brain className="size-3.5 mr-1.5" /> Intelligence
          </TabsTrigger>
          <TabsTrigger value="emotion" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <Heart className="size-3.5 mr-1.5" /> Emotion
          </TabsTrigger>
          <TabsTrigger value="performance" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <Users className="size-3.5 mr-1.5" /> Agent
          </TabsTrigger>
          <TabsTrigger value="resolution" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <ListChecks className="size-3.5 mr-1.5" /> Resolution
          </TabsTrigger>
          <TabsTrigger value="risk" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <ShieldAlert className="size-3.5 mr-1.5" /> Risk
          </TabsTrigger>
          <TabsTrigger value="transcript" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <MessageSquare className="size-3.5 mr-1.5" /> Transcript
          </TabsTrigger>
          <TabsTrigger value="cost" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <DollarSign className="size-3.5 mr-1.5" /> Cost
          </TabsTrigger>
        </TabsList>

        {/* ─── Summary tab (synthesizer output) ────────────────────────── */}
        <TabsContent value="summary" className="space-y-4 mt-4">
          <Card className="rounded-2xl border-slate-200">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
                <FileText className="size-4 text-blue-600" />
                <span>Executive Summary</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed text-slate-700">{execSummary || "—"}</p>
            </CardContent>
          </Card>

          {headline && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
              {Object.entries(headline).map(([k, v]) => (
                <div key={k} className="rounded-xl bg-white border border-slate-200 p-3">
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1">
                    {k.replace(/_/g, " ")}
                  </div>
                  <div className="text-sm font-semibold text-slate-900 break-words">{String(v)}</div>
                </div>
              ))}
            </div>
          )}

          {Array.isArray(syn?.key_findings) && (syn?.key_findings as unknown[]).length > 0 && (
            <Card className="rounded-2xl border-slate-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2.5">
                  <ListChecks className="size-4 text-purple-600" />
                  <span>Key Findings</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-2">
                  {(syn?.key_findings as string[]).map((f, i) => (
                    <li key={i} className="flex gap-3 text-sm text-slate-700">
                      <span className="flex-shrink-0 mt-0.5 size-5 rounded-full bg-purple-50 text-purple-700 text-[11px] font-semibold border border-purple-200 flex items-center justify-center">
                        {i + 1}
                      </span>
                      <span className="leading-relaxed">{f}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}

          {Array.isArray(syn?.next_best_actions) && (syn?.next_best_actions as unknown[]).length > 0 && (
            <Card className="rounded-2xl border-slate-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2.5">
                  <ShieldAlert className="size-4 text-emerald-600" />
                  <span>Next Best Actions</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {(syn?.next_best_actions as Array<Record<string, unknown>>).map((a, i) => (
                    <div key={i} className="rounded-lg bg-slate-50/70 border border-slate-100 p-3">
                      <div className="text-sm text-slate-800">{String(a.action)}</div>
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {a.owner && <Badge variant="outline" className="text-[10px] py-0">owner: {String(a.owner)}</Badge>}
                        {a.priority && (
                          <Badge variant="outline" className={`text-[10px] py-0 ${
                            a.priority === "high" ? "bg-red-50 text-red-700 border-red-200"
                            : a.priority === "medium" ? "bg-amber-50 text-amber-700 border-amber-200"
                            : "bg-slate-50 text-slate-600"
                          }`}>
                            {String(a.priority)}
                          </Badge>
                        )}
                        {a.timeline && <Badge variant="outline" className="text-[10px] py-0">{String(a.timeline)}</Badge>}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ─── Specialist tabs ────────────────────────────────────────── */}
        <TabsContent value="intel"       className="mt-4"><IntelligenceView output={specs.intelligence.output} /></TabsContent>
        <TabsContent value="emotion"     className="mt-4"><EmotionView      output={specs.emotion.output} /></TabsContent>
        <TabsContent value="performance" className="mt-4"><PerformanceView  output={specs.performance.output} /></TabsContent>
        <TabsContent value="resolution"  className="mt-4"><ResolutionView   output={specs.resolution.output} /></TabsContent>
        <TabsContent value="risk"        className="mt-4"><RiskView         output={specs.risk.output} /></TabsContent>

        {/* ─── Transcript tab ─────────────────────────────────────────── */}
        <TabsContent value="transcript" className="mt-4">
          <TranscriptView result={result} />
        </TabsContent>

        {/* ─── Cost tab ──────────────────────────────────────────────── */}
        <TabsContent value="cost" className="mt-4">
          <CostBreakdown
            unified={result.unified_cost}
            sttCost={result.stage_1_stt.cost}
            sentiment={result.stage_2_sentiment_multi_agent}
            audioMinutes={result.audio_meta.audio_minutes}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};

// ─── Transcript view with per-utterance emotion shading ────────────────────
const TranscriptView = ({ result }: { result: AnalysisRecord }) => {
  const utterances = result.stage_1_stt.utterances;
  const emotionOut = result.stage_2_sentiment_multi_agent.specialists.emotion.output as Record<string, unknown>;
  const perUtt = (emotionOut?.per_utterance as Array<{ idx?: number; emotion?: string; intensity_1_10?: number; tonality?: string }>) || [];

  const emotionToBorderColor = (emotion?: string, intensity?: number): string => {
    const i = intensity ?? 5;
    const positive = ["joy", "satisfaction"];
    const negative = ["anger", "fear", "sadness", "disgust", "frustration", "anxiety"];
    if (positive.includes(emotion || "")) return i > 6 ? "border-l-emerald-500" : "border-l-emerald-300";
    if (negative.includes(emotion || "")) return i > 6 ? "border-l-red-500" : "border-l-amber-400";
    return "border-l-slate-200";
  };

  return (
    <Card className="rounded-2xl border-slate-200">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
          <MessageSquare className="size-4 text-purple-600" />
          <span>Diarized Transcript</span>
          <Badge variant="outline" className="ml-auto text-[10px] font-normal">
            {utterances.length} utterances · {result.audio_meta.num_speakers} speakers · {result.audio_meta.language_code}
          </Badge>
        </CardTitle>
        {result.audio_meta.keyterms_applied.length > 0 && (
          <div className="flex items-start gap-2 mt-2 text-xs text-slate-500">
            <Tag className="size-3 mt-0.5 flex-shrink-0" />
            <span>
              Biased toward: {result.audio_meta.keyterms_applied.slice(0, 8).join(", ")}
              {result.audio_meta.keyterms_applied.length > 8 && ` (+${result.audio_meta.keyterms_applied.length - 8} more)`}
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
          {utterances.map((u, i) => {
            const e = perUtt[i];
            const borderClass = emotionToBorderColor(e?.emotion, e?.intensity_1_10);
            const t = u.start_s ?? 0;
            const mm = Math.floor(t / 60);
            const ss = Math.floor(t % 60);
            return (
              <div
                key={i}
                className={`flex gap-3 pl-3 py-2 border-l-2 ${borderClass} bg-slate-50/40 hover:bg-slate-50 rounded-r-lg transition-colors`}
              >
                <div className="flex-shrink-0 text-[11px] text-slate-400 font-mono pt-0.5 w-12">
                  {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
                </div>
                <div className="flex-shrink-0 w-20">
                  <Badge variant="outline" className="text-[10px] font-mono py-0">
                    {u.speaker || "?"}
                  </Badge>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-800 leading-relaxed">{u.text}</div>
                  {e && (e.emotion || e.tonality) && (
                    <div className="flex gap-1.5 flex-wrap mt-1">
                      {e.emotion && (
                        <Badge variant="outline" className="text-[9px] py-0 bg-white">
                          {e.emotion}{e.intensity_1_10 ? ` ${e.intensity_1_10}/10` : ""}
                        </Badge>
                      )}
                      {e.tonality && (
                        <Badge variant="outline" className="text-[9px] py-0 bg-white text-slate-500">
                          {e.tonality}
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};

export default CallAnalysisPipeline;
