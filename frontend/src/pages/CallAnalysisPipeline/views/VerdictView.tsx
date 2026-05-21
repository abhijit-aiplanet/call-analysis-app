import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  ShieldAlert, AlertTriangle, CheckCircle2, User, UserCheck,
  Phone, Gavel, Sparkles, MessageSquareQuote,
} from "lucide-react";
import type { RCUVerdictBlock } from "../types";
import { VERDICT_TONE, ROUTING_TONE } from "../types";

interface Props {
  verdict: RCUVerdictBlock;
}

const CALLER_ICON: Record<string, typeof User> = {
  "Applicant": User,
  "Co-applicant": UserCheck,
  "Monnai": Phone,
};

export const VerdictView = ({ verdict }: Props) => {
  const tone = VERDICT_TONE[verdict.verdict || "Unknown"] || VERDICT_TONE.Unknown;
  const route = ROUTING_TONE[verdict.decision_routing || ""] ||
                { bg: "bg-slate-100", text: "text-slate-600", label: verdict.decision_routing || "—" };
  const conf = verdict.verdict_confidence_1_10 ?? 0;
  const CallerIcon = CALLER_ICON[verdict.caller_type || ""] || User;

  return (
    <div className="space-y-4">
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
