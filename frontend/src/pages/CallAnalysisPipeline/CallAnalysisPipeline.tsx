import { useEffect, useRef, useState } from "react";
import Layout from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sparkles, MessageSquare, Tag, ArrowLeft,
  ShieldAlert, AlertTriangle, CheckCircle2,
  FileText, ShieldCheck, MessageCircle, UserCheck, DollarSign,
  XCircle, Gavel,
} from "lucide-react";

import { createBatch, getBatch } from "./api";
import type { BatchJob, BatchFileEntry, AnalysisRecord } from "./types";
import { VERDICT_TONE, ROUTING_TONE } from "./types";
import { BatchUploader } from "./BatchUploader";
import { BatchProgress } from "./BatchProgress";
import { BatchSummary } from "./BatchSummary";
import { FileSelector } from "./FileSelector";
import { CostBreakdown } from "./CostBreakdown";
import { VerdictView } from "./views/VerdictView";
import { IdentityCheckView } from "./views/IdentityCheckView";
import { RiskView } from "./views/RiskView";
import { ConversationView } from "./views/ConversationView";

type PageState = "uploading" | "submitting" | "processing" | "done";

const CallAnalysisPipeline = () => {
  const [pageState, setPageState] = useState<PageState>("uploading");
  const [job, setJob] = useState<BatchJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFileIdx, setSelectedFileIdx] = useState(0);
  const [activeTab, setActiveTab] = useState("verdict");
  const pollTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!job || pageState === "done") return;
    if (job.status === "completed" || job.status === "completed_with_errors" || job.status === "failed") {
      setPageState("done");
      const firstOk = job.files.findIndex((f) => f.status === "ok");
      if (firstOk >= 0) setSelectedFileIdx(firstOk);
      return;
    }
    pollTimeoutRef.current = window.setTimeout(async () => {
      try {
        const updated = await getBatch(job.job_id);
        setJob(updated);
      } catch (e) {
        console.error("poll error:", e);
      }
    }, 2000) as unknown as number;
    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [job, pageState]);

  const handleSubmit = async (files: File[], keyterms: string[]) => {
    setPageState("submitting");
    setError(null);
    try {
      const resp = await createBatch(files, keyterms);
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
    setActiveTab("verdict");
    setPageState("uploading");
  };

  const selectedFile: BatchFileEntry | null = job?.files[selectedFileIdx] ?? null;
  const selectedResult: AnalysisRecord | null = selectedFile?.result ?? null;

  return (
    <Layout
      title="RCU AI Verification"
      description="Bajaj Auto Credit · Risk Containment Unit · automated Telephonic Confirmation. ElevenLabs Scribe v2 STT + 4-specialist verification + Decision Agent. Outputs verdict (Positive / Negative / Critical), disposition, confidence, and routing — all in under 5 minutes per call."
      category="Risk Containment Unit"
    >
      <div className="space-y-6 font-inter">
        {(pageState === "uploading" || pageState === "submitting") && (
          <BatchUploader
            onSubmit={handleSubmit}
            isSubmitting={pageState === "submitting"}
            error={error}
          />
        )}

        {(pageState === "processing" || pageState === "done") && job && (
          <>
            {/* Header strip */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                {job.keyterms.length > 0 && (
                  <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200 font-normal">
                    <Tag className="size-3 mr-1" />
                    {job.keyterms.length} keyterm{job.keyterms.length !== 1 ? "s" : ""}
                  </Badge>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={handleReset} className="h-8">
                <ArrowLeft className="size-3.5 mr-1.5" />
                New Batch
              </Button>
            </div>

            {pageState === "processing" && <BatchProgress job={job} />}

            {pageState === "done" && job.aggregate_cost && <BatchSummary job={job} />}

            {pageState === "done" && job.failed_count > 0 && (
              <FailedFilesPanel job={job} />
            )}

            {job.files.some((f) => f.status === "ok") && (
              <>
                <FileSelector
                  files={job.files}
                  selectedIdx={selectedFileIdx}
                  onSelect={(i) => { setSelectedFileIdx(i); setActiveTab("verdict"); }}
                />

                {selectedResult && (
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
  const verdict = result.rcu_verdict;
  const verification = result.stage_2_verification;
  const specs = verification.specialists;
  const triage = verification.triage;
  const reflection = verification.reflection;
  const triaged = !!(verdict.triage_short_circuit || triage?.short_circuited);
  const verdictTone = VERDICT_TONE[verdict.verdict || "Unknown"] || VERDICT_TONE.Unknown;
  const routingTone = ROUTING_TONE[verdict.decision_routing || ""] ||
    { bg: "bg-slate-100", text: "text-slate-600", label: verdict.decision_routing || "—" };

  return (
    <div className="space-y-4">
      {/* Always-visible verdict strip */}
      <Card className={`rounded-2xl border-2 ${verdictTone.border} ${verdictTone.bg.replace("100", "50/50")}`}>
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
          <Badge className={`${verdictTone.bg} ${verdictTone.text} ${verdictTone.border} font-bold text-base px-4 py-1.5`}>
            {verdict.verdict === "Critical" && <ShieldAlert className="size-4 mr-1.5" />}
            {verdict.verdict === "Negative" && <AlertTriangle className="size-4 mr-1.5" />}
            {verdict.verdict === "Positive" && <CheckCircle2 className="size-4 mr-1.5" />}
            {verdict.verdict || "—"}
          </Badge>
          <Badge variant="outline" className="bg-white font-medium text-slate-800">
            {verdict.disposition || "—"}
          </Badge>
          <Badge variant="outline" className="bg-white text-slate-700">
            Caller: {verdict.caller_type || "Unknown"}
          </Badge>
          <Badge className={`${routingTone.bg} ${routingTone.text} font-medium`}>
            <Gavel className="size-3 mr-1" />
            {routingTone.label}
          </Badge>
          <div className="ml-auto flex items-center gap-2 flex-wrap text-[11px]">
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
          <TabsTrigger value="verdict" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <Sparkles className="size-3.5 mr-1.5" /> Verdict
          </TabsTrigger>
          {!triaged && (
            <>
              <TabsTrigger value="identity" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
                <UserCheck className="size-3.5 mr-1.5" /> Identity
              </TabsTrigger>
              <TabsTrigger value="risk" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
                <ShieldCheck className="size-3.5 mr-1.5" /> Risk
              </TabsTrigger>
              <TabsTrigger value="conversation" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
                <MessageCircle className="size-3.5 mr-1.5" /> Conversation
              </TabsTrigger>
            </>
          )}
          <TabsTrigger value="transcript" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <MessageSquare className="size-3.5 mr-1.5" /> Transcript
          </TabsTrigger>
          <TabsTrigger value="cost" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <DollarSign className="size-3.5 mr-1.5" /> Cost
          </TabsTrigger>
        </TabsList>

        <TabsContent value="verdict" className="mt-4">
          <VerdictView verdict={verdict} triage={triage} reflection={reflection} />
        </TabsContent>
        {!triaged && specs.identity_verification && specs.information_extraction && (
          <TabsContent value="identity" className="mt-4">
            <IdentityCheckView
              identityVerificationOutput={specs.identity_verification.output}
              informationExtractionOutput={specs.information_extraction.output}
            />
          </TabsContent>
        )}
        {!triaged && specs.fraud_risk && (
          <TabsContent value="risk" className="mt-4"><RiskView output={specs.fraud_risk.output} /></TabsContent>
        )}
        {!triaged && specs.conversation_behavior && (
          <TabsContent value="conversation" className="mt-4"><ConversationView output={specs.conversation_behavior.output} /></TabsContent>
        )}

        <TabsContent value="transcript" className="mt-4">
          <TranscriptView result={result} />
        </TabsContent>

        <TabsContent value="cost" className="mt-4">
          <CostBreakdown
            unified={result.unified_cost}
            sttCost={result.stage_1_stt.cost}
            verification={result.stage_2_verification}
            audioMinutes={result.audio_meta.audio_minutes}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};

// ─── Transcript view ───────────────────────────────────────────────────────
const TranscriptView = ({ result }: { result: AnalysisRecord }) => {
  const utterances = result.stage_1_stt.utterances;
  const behaviorOut = result.stage_2_verification.specialists?.conversation_behavior?.output as Record<string, unknown> | undefined;
  const perUtt = (behaviorOut?.per_utterance as Array<{ idx?: number; speaker_role?: string; behavior_tag?: string }>) || [];

  const borderColorFor = (idx: number): string => {
    const tag = perUtt[idx]?.behavior_tag || "neutral";
    if (["prompted_by_third_party", "contradictory", "evasive", "irate", "defensive"].includes(tag))
      return "border-l-red-500";
    if (["fumbling", "hesitant", "rushed_through", "rehearsed"].includes(tag))
      return "border-l-amber-400";
    if (["cooperative"].includes(tag))
      return "border-l-emerald-400";
    return "border-l-slate-200";
  };

  const roleLabel = (idx: number): string | null => {
    const role = perUtt[idx]?.speaker_role;
    if (role === "agent") return "AGENT";
    if (role === "subject") return "SUBJECT";
    if (role === "third_party") return "3RD-PARTY";
    return null;
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
            const role = roleLabel(i);
            const tag = perUtt[i]?.behavior_tag;
            const t = u.start_s ?? 0;
            const mm = Math.floor(t / 60);
            const ss = Math.floor(t % 60);
            return (
              <div
                key={i}
                className={`flex gap-3 pl-3 py-2 border-l-2 ${borderColorFor(i)} bg-slate-50/40 hover:bg-slate-50 rounded-r-lg transition-colors`}
              >
                <div className="flex-shrink-0 text-[11px] text-slate-400 font-mono pt-0.5 w-12">
                  {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
                </div>
                <div className="flex-shrink-0 w-24">
                  <Badge variant="outline" className={`text-[10px] font-mono py-0 ${
                    role === "AGENT" ? "bg-blue-50 text-blue-700 border-blue-200" :
                    role === "SUBJECT" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                    role === "3RD-PARTY" ? "bg-red-50 text-red-700 border-red-200" :
                    "bg-slate-50"
                  }`}>
                    {role || u.speaker || "?"}
                  </Badge>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-800 leading-relaxed">{u.text}</div>
                  {tag && tag !== "neutral" && (
                    <div className="mt-1">
                      <Badge variant="outline" className="text-[9px] py-0 bg-white text-slate-600">
                        {tag}
                      </Badge>
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

// ─── Failed Files Panel (kept from prior build) ────────────────────────────
const FailedFilesPanel = ({ job }: { job: BatchJob }) => {
  const failed = job.files.filter((f) => f.status === "error");
  if (failed.length === 0) return null;

  const friendly = (err: string | null): { hint: string; tone: "red" | "amber" } | null => {
    if (!err) return null;
    const lower = err.toLowerCase();
    if (lower.includes("detected_unusual_activity") || lower.includes("free tier usage disabled"))
      return {
        hint: "ElevenLabs disabled free-tier access for this key. Upgrade to Starter ($5/mo) at elevenlabs.io/app/subscription.",
        tone: "red",
      };
    if (lower.includes("quota_exceeded") || lower.includes("credits remaining"))
      return { hint: "ElevenLabs Scribe quota exhausted. Top up credits.", tone: "red" };
    if (lower.includes("deploymentnotfound") || lower.includes("404"))
      return { hint: "Azure OpenAI deployment hiccup — retry usually fixes it.", tone: "amber" };
    if (lower.includes("internalserver") || lower.includes("500"))
      return { hint: "Azure / vendor 500. Retry.", tone: "amber" };
    if (lower.includes("invalid_request") || lower.includes("invalid audio"))
      return { hint: "Audio file may be empty, corrupt, or unsupported format.", tone: "red" };
    if (lower.includes("timeout") || lower.includes("connectionerror"))
      return { hint: "Network timeout — possibly cold-start. Retry.", tone: "amber" };
    return null;
  };

  return (
    <Card className="rounded-2xl border-red-200 bg-red-50/50 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2.5 text-base font-semibold text-red-900">
          <AlertTriangle className="size-5 text-red-600" />
          <span>{failed.length} of {job.file_count} file{failed.length !== 1 ? "s" : ""} failed</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2.5">
          {failed.map((f, i) => {
            const f_hint = friendly(f.error);
            return (
              <div key={i} className="bg-white border border-red-100 rounded-lg p-3">
                <div className="flex items-start gap-2.5">
                  <XCircle className="size-4 text-red-500 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 truncate">{f.filename}</div>
                    {f_hint && (
                      <div className={`mt-1.5 px-2.5 py-1.5 rounded text-xs ${
                        f_hint.tone === "red"
                          ? "bg-red-100 text-red-800 border border-red-200"
                          : "bg-amber-100 text-amber-800 border border-amber-200"
                      }`}>
                        {f_hint.hint}
                      </div>
                    )}
                    {f.error && (
                      <details className="mt-1.5">
                        <summary className="text-[11px] text-slate-500 cursor-pointer hover:text-slate-700 select-none">
                          show full error
                        </summary>
                        <pre className="text-[10px] text-red-700 font-mono mt-1 whitespace-pre-wrap break-words bg-slate-50 p-2 rounded border border-slate-200">
                          {f.error}
                        </pre>
                      </details>
                    )}
                  </div>
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
