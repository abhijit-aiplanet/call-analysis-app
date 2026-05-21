import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  ShieldAlert, AlertTriangle, CheckCircle2, User, UserCheck,
  Phone, Gavel, Sparkles, MessageSquareQuote, Zap, Eye, ListChecks,
} from "lucide-react";
import type { RCUVerdictBlock, ReflectionBlock, TriageBlock } from "../types";
import { VERDICT_TONE, ROUTING_TONE } from "../types";

interface Props {
  verdict: RCUVerdictBlock;
  triage?: TriageBlock;
  reflection?: ReflectionBlock;
}

const CALLER_ICON: Record<string, typeof User> = {
  "Applicant": User,
  "Co-applicant": UserCheck,
  "Monnai": Phone,
};

export const VerdictView = ({ verdict, triage, reflection }: Props) => {
  const tone = VERDICT_TONE[verdict.verdict || "Unknown"] || VERDICT_TONE.Unknown;
  const route = ROUTING_TONE[verdict.decision_routing || ""] ||
                { bg: "bg-slate-100", text: "text-slate-600", label: verdict.decision_routing || "—" };
  const conf = verdict.verdict_confidence_1_10 ?? 0;
  const CallerIcon = CALLER_ICON[verdict.caller_type || ""] || User;

  const triageShortCircuit = verdict.triage_short_circuit || triage?.short_circuited;
  const reflectionApplied = verdict.reflection_applied || reflection?.applied;
  const refOut = reflection?.output;
  const preRefl = verdict.pre_reflection;

  return (
    <div className="space-y-4">
      {/* Triage short-circuit banner */}
      {triageShortCircuit && (
        <Card className="rounded-2xl border-blue-200 bg-blue-50/60">
          <CardContent className="p-3 flex items-start gap-3">
            <div className="bg-blue-100 rounded-md p-1.5 flex-shrink-0">
              <Zap className="size-4 text-blue-700" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-700 mb-0.5">
                Triaged — full pipeline skipped
              </div>
              <p className="text-sm text-slate-700">{triage?.output?.rationale || "Disposed by triage agent."}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Reflection adjustment banner */}
      {reflectionApplied && refOut && (
        <Card className="rounded-2xl border-amber-200 bg-amber-50/60">
          <CardContent className="p-3 space-y-2">
            <div className="flex items-start gap-3">
              <div className="bg-amber-100 rounded-md p-1.5 flex-shrink-0">
                <Eye className="size-4 text-amber-700" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-800">
                    Reflection adjusted the verdict
                  </span>
                  <Badge variant="outline" className="bg-white text-[10px] capitalize">
                    {refOut.agreement_with_decision} agreement
                  </Badge>
                  {refOut.confidence_delta !== 0 && (
                    <Badge variant="outline" className="bg-white text-[10px] font-mono">
                      conf {refOut.confidence_delta > 0 ? "+" : ""}{refOut.confidence_delta}
                    </Badge>
                  )}
                  {refOut.routing_override && (
                    <Badge variant="outline" className="bg-white text-[10px]">
                      route → {refOut.routing_override}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-slate-700">{refOut.reviewer_notes}</p>
                {preRefl && (
                  <p className="text-[11px] text-slate-500 mt-1 font-mono">
                    before: conf {preRefl.verdict_confidence_1_10 ?? "—"} · route {preRefl.decision_routing || "—"}
                  </p>
                )}
              </div>
            </div>
            {refOut.issues_found && refOut.issues_found.length > 0 && (
              <div className="pl-9 space-y-1">
                {refOut.issues_found.map((iss, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <Badge
                      variant="outline"
                      className={`text-[9px] flex-shrink-0 ${
                        iss.severity === "high" ? "bg-red-50 text-red-700 border-red-200"
                        : iss.severity === "medium" ? "bg-amber-50 text-amber-700 border-amber-200"
                        : "bg-slate-50 text-slate-600 border-slate-200"
                      }`}
                    >
                      {iss.severity}
                    </Badge>
                    <span className="text-slate-600"><span className="font-medium text-slate-700">{iss.check}:</span> {iss.description}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Hero verdict card */}
      <Card className={`rounded-2xl border-2 ${tone.border} ${tone.bg.replace("100", "50/50")} shadow-sm`}>
        <CardContent className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
            {/* Verdict + disposition column */}
            <div className="md:col-span-7 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <Badge className={`${tone.bg} ${tone.text} ${tone.border} font-bold text-base px-4 py-1.5`}>
                  {verdict.verdict === "Critical" && <ShieldAlert className="size-4 mr-1.5" />}
                  {verdict.verdict === "Negative" && <AlertTriangle className="size-4 mr-1.5" />}
                  {verdict.verdict === "Positive" && <CheckCircle2 className="size-4 mr-1.5" />}
                  {verdict.verdict || "—"}
                </Badge>
                <Badge variant="outline" className="bg-white font-medium text-slate-800 text-sm px-3 py-1">
                  {verdict.disposition || "—"}
                </Badge>
              </div>
              {verdict.headline_chip && (
                <p className="text-sm leading-relaxed text-slate-700 italic">"{verdict.headline_chip}"</p>
              )}
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <Badge variant="outline" className="bg-white">
                  <CallerIcon className="size-3 mr-1" />
                  Caller: {verdict.caller_type || "Unknown"}
                </Badge>
                {verdict.decision_routing && (
                  <Badge className={`${route.bg} ${route.text} font-medium`}>
                    <Gavel className="size-3 mr-1" />
                    {route.label}
                  </Badge>
                )}
              </div>
            </div>

            {/* Confidence meter column */}
            <div className="md:col-span-5">
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1">
                  Verdict confidence
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-slate-900">{conf}</span>
                  <span className="text-base text-slate-400">/10</span>
                </div>
                <Progress
                  value={conf * 10}
                  className={`h-2 mt-2 ${
                    conf >= 8 ? "[&>div]:bg-emerald-500"
                    : conf >= 5 ? "[&>div]:bg-amber-500"
                                : "[&>div]:bg-red-500"
                  }`}
                />
                <div className="text-[10px] text-slate-500 mt-1">
                  {conf >= 8 ? "high confidence" : conf >= 5 ? "moderate" : "low — needs review"}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Executive summary */}
      {verdict.executive_summary && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
              <div className="bg-blue-50 border border-blue-100 rounded-lg p-2">
                <MessageSquareQuote className="size-4 text-blue-700" />
              </div>
              <span>Executive Summary</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed text-slate-700">{verdict.executive_summary}</p>
            {verdict.rationale && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1">
                  Rubric rationale
                </div>
                <p className="text-xs text-slate-600 leading-relaxed italic">{verdict.rationale}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Reasoning chain (chain-of-thought from Decision Agent) */}
      {verdict.reasoning_chain && verdict.reasoning_chain.length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
              <ListChecks className="size-4 text-indigo-600" />
              <span>Decision Reasoning</span>
              <Badge variant="outline" className="ml-auto text-[10px] font-normal">
                {verdict.reasoning_chain.length} steps
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-1.5 text-sm text-slate-700">
              {verdict.reasoning_chain.map((step, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-[10px] font-mono text-slate-400 flex-shrink-0 pt-0.5 w-5">
                    {i + 1}.
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            {verdict.disposition_override_suggestion && (
              <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-amber-800 bg-amber-50/40 -mx-3 -mb-3 px-3 py-2 rounded-b-lg">
                Reflection suggests considering disposition: <span className="font-semibold">{verdict.disposition_override_suggestion}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Routing reasoning */}
      {verdict.routing_rationale && (
        <Card className="rounded-2xl border-slate-200 bg-slate-50/40">
          <CardContent className="p-4 flex items-start gap-3">
            <Gavel className="size-4 text-slate-500 mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1">
                Routing decision
              </div>
              <p className="text-sm text-slate-700">{verdict.routing_rationale}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Risk tags */}
      {verdict.risk_tags && verdict.risk_tags.length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
              <ShieldAlert className="size-4 text-orange-600" />
              <span>Detected Risk Patterns</span>
              <Badge variant="outline" className="ml-auto text-[10px] font-normal">
                {verdict.risk_tags.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {verdict.risk_tags.map((tag, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className={`font-mono text-[11px] font-normal ${
                    tag.startsWith("third_party") || tag.startsWith("info_mismatch") ||
                    tag.startsWith("loan_") || tag.includes("monnai") || tag.includes("wrong_number") ||
                    tag.includes("vehicle_delivered")
                      ? "bg-red-50 text-red-700 border-red-200"
                      : tag.startsWith("refused_") || tag.includes("incomplete") || tag.includes("only_enquiry")
                      ? "bg-amber-50 text-amber-700 border-amber-200"
                      : "bg-slate-50 text-slate-600 border-slate-200"
                  }`}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Key evidence quotes */}
      {verdict.key_evidence_quotes && verdict.key_evidence_quotes.length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
              <Sparkles className="size-4 text-purple-600" />
              <span>Supporting Evidence</span>
              <Badge variant="outline" className="ml-auto text-[10px] font-normal">
                {verdict.key_evidence_quotes.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {verdict.key_evidence_quotes.map((q, i) => (
                <div key={i} className="bg-purple-50/40 border border-purple-100 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <Badge variant="outline" className="bg-white text-purple-700 border-purple-200 font-mono text-[10px]">
                      {q.tag}
                    </Badge>
                    {q.timestamp_s != null && (
                      <span className="text-[10px] text-slate-500 font-mono flex-shrink-0">
                        {Math.floor(q.timestamp_s / 60).toString().padStart(2, "0")}:{Math.floor(q.timestamp_s % 60).toString().padStart(2, "0")}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-700 italic">"{q.quote}"</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
