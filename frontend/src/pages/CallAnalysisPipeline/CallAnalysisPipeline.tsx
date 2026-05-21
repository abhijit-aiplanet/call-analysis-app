import { useEffect, useRef, useState } from "react";
import Layout from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sparkles, Tag, ArrowLeft,
  ShieldAlert, AlertTriangle, CheckCircle2,
  ShieldCheck, MessageCircle, UserCheck, IndianRupee,
  XCircle, Gavel, MessageSquare,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { inr } from "@/lib/currency";
import { createBatch, getBatch } from "./api";
import type { BatchJob, BatchFileEntry, AnalysisRecord } from "./types";
import { VERDICT_TONE, ROUTING_TONE } from "./types";
import { BatchUploader } from "./BatchUploader";
import { BatchProgress } from "./BatchProgress";
import { FileSelector } from "./FileSelector";
import { CostBreakdown } from "./CostBreakdown";
import { VerdictView } from "./views/VerdictView";
import { IdentityCheckView } from "./views/IdentityCheckView";
import { RiskView } from "./views/RiskView";
import { ConversationView } from "./views/ConversationView";
import { AudioTranscript } from "./AudioTranscript";

type PageState = "uploading" | "submitting" | "processing" | "done";

const CallAnalysisPipeline = () => {
  const [pageState, setPageState] = useState<PageState>("uploading");
  const [job, setJob] = useState<BatchJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFileIdx, setSelectedFileIdx] = useState(0);
  const [activeTab, setActiveTab] = useState("verdict");
  // Map of original filename → blob URL so we can play back the audio the
  // user uploaded. Kept in-memory (revoked on reset / unmount).
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
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

  // Revoke object URLs when the component unmounts
  useEffect(() => {
    return () => {
      Object.values(audioUrls).forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (files: File[], keyterms: string[]) => {
    setPageState("submitting");
    setError(null);
    try {
      const resp = await createBatch(files, keyterms);
      const initial = await getBatch(resp.job_id);
      // Build per-filename blob URLs so the transcript view can play the audio
      const urlMap: Record<string, string> = {};
      files.forEach((f) => { urlMap[f.name] = URL.createObjectURL(f); });
      // Revoke any previous URLs first
      Object.values(audioUrls).forEach((u) => URL.revokeObjectURL(u));
      setAudioUrls(urlMap);
      setJob(initial);
      setPageState("processing");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to submit batch";
      setError(msg);
      setPageState("uploading");
    }
  };

  const handleReset = () => {
    Object.values(audioUrls).forEach((u) => URL.revokeObjectURL(u));
    setAudioUrls({});
    setJob(null);
    setError(null);
    setSelectedFileIdx(0);
    setActiveTab("verdict");
    setPageState("uploading");
  };

  const selectedFile: BatchFileEntry | null = job?.files[selectedFileIdx] ?? null;
  const selectedResult: AnalysisRecord | null = selectedFile?.result ?? null;
  const selectedAudioUrl = selectedFile ? audioUrls[selectedFile.filename] || null : null;

  return (
    <Layout
      title="RCU AI Verification"
      description="Bajaj Auto Credit · Risk Containment Unit · automated Telephonic Confirmation. Soniox stt-async-v4 STT + Triage + 4 specialists + Decision Agent + Reflection. Outputs verdict (Positive / Negative / Critical), disposition, confidence, and routing — all in under 5 minutes per call."
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
                    audioUrl={selectedAudioUrl}
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
  audioUrl: string | null;
  activeTab: string;
  setActiveTab: (t: string) => void;
}

interface TabDef {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  show: boolean;
}

const PerFileDetail = ({ result, audioUrl, activeTab, setActiveTab }: PerFileDetailProps) => {
  const verdict = result.rcu_verdict;
  const verification = result.stage_2_verification;
  const specs = verification.specialists;
  const triage = verification.triage;
  const reflection = verification.reflection;
  const triaged = !!(verdict.triage_short_circuit || triage?.short_circuited);
  const verdictTone = VERDICT_TONE[verdict.verdict || "Unknown"] || VERDICT_TONE.Unknown;
  const routingTone = ROUTING_TONE[verdict.decision_routing || ""] ||
    { bg: "bg-slate-100", text: "text-slate-600", label: verdict.decision_routing || "—" };

  const tabs: TabDef[] = [
    { id: "verdict",      label: "Verdict",      icon: Sparkles,       show: true },
    { id: "identity",     label: "Identity",     icon: UserCheck,      show: !triaged && (!!specs.identity_and_extraction || (!!specs.identity_verification && !!specs.information_extraction)) },
    { id: "risk",         label: "Risk",         icon: ShieldCheck,    show: !triaged && !!specs.fraud_risk },
    { id: "conversation", label: "Conversation", icon: MessageCircle,  show: !triaged && !!specs.conversation_behavior },
    { id: "transcript",   label: "Transcript",   icon: MessageSquare,  show: true },
    { id: "cost",         label: "Cost",         icon: IndianRupee,    show: true },
  ];

  // If active tab gets hidden (e.g. triage short-circuit), fall back to verdict
  useEffect(() => {
    const t = tabs.find((x) => x.id === activeTab);
    if (!t || !t.show) setActiveTab("verdict");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triaged]);

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
              {inr(result.unified_cost.total_usd)}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Pill-style tab nav — fills full width, equal-width pills */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-1.5 flex items-stretch gap-1">
        {tabs.filter((t) => t.show).map((t) => {
          const Icon = t.icon;
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={cn(
                "flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl text-sm font-medium transition-all duration-150",
                isActive
                  ? "bg-gradient-to-r from-emerald-600 to-emerald-500 text-white shadow-md shadow-emerald-500/30"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100/80",
              )}
            >
              <Icon className={cn("size-4 flex-shrink-0", isActive ? "text-white" : "text-slate-500")} />
              <span className="truncate">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      {activeTab === "verdict" && (
        <VerdictView verdict={verdict} triage={triage} reflection={reflection} />
      )}
      {activeTab === "identity" && !triaged && (specs.identity_and_extraction || (specs.identity_verification && specs.information_extraction)) && (
        <IdentityCheckView
          identityVerificationOutput={
            (specs.identity_and_extraction?.output ?? specs.identity_verification?.output) || {}
          }
          informationExtractionOutput={
            (specs.identity_and_extraction?.output ?? specs.information_extraction?.output) || {}
          }
        />
      )}
      {activeTab === "risk" && !triaged && specs.fraud_risk && (
        <RiskView output={specs.fraud_risk.output} />
      )}
      {activeTab === "conversation" && !triaged && specs.conversation_behavior && (
        <ConversationView output={specs.conversation_behavior.output} />
      )}
      {activeTab === "transcript" && (
        <AudioTranscript result={result} audioUrl={audioUrl} />
      )}
      {activeTab === "cost" && (
        <CostBreakdown
          unified={result.unified_cost}
          sttCost={result.stage_1_stt.cost}
          verification={result.stage_2_verification}
          audioMinutes={result.audio_meta.audio_minutes}
          sttVendor={result.stage_1_stt.vendor}
        />
      )}
    </div>
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
