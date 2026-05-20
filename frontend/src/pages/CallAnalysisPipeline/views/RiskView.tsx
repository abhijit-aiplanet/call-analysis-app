import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  ShieldAlert, AlertOctagon, Gavel, AlertTriangle, ShieldCheck, Megaphone,
} from "lucide-react";

interface Props {
  output: Record<string, unknown>;
}

const SEVERITY_TONE: Record<string, string> = {
  low:      "bg-slate-100 text-slate-600 border-slate-200",
  medium:   "bg-amber-100 text-amber-700 border-amber-200",
  high:     "bg-orange-100 text-orange-700 border-orange-200",
  critical: "bg-red-100 text-red-700 border-red-200",
};

const RISK_LABEL_TONE: Record<string, string> = {
  no_risk:                       "bg-emerald-100 text-emerald-700 border-emerald-200",
  low_risk:                      "bg-slate-100 text-slate-600 border-slate-200",
  medium_risk:                   "bg-amber-100 text-amber-700 border-amber-200",
  high_risk:                     "bg-orange-100 text-orange-700 border-orange-200",
  critical_compliance_breach:    "bg-red-100 text-red-700 border-red-200",
};

const INTERVENTION_TONE: Record<string, string> = {
  none:                       "bg-slate-100 text-slate-600 border-slate-200",
  normal_ticket:              "bg-blue-100 text-blue-700 border-blue-200",
  high_priority_ticket:       "bg-amber-100 text-amber-700 border-amber-200",
  urgent_human_intervention:  "bg-orange-100 text-orange-700 border-orange-200",
  escalate_to_compliance:     "bg-red-100 text-red-700 border-red-200",
};

interface FraudSignal {
  signal?: string;
  severity?: string;
  evidence?: string;
}

interface ComplianceConcern {
  type?: string;
  severity?: string;
  evidence?: string;
}

export const RiskView = ({ output }: Props) => {
  const fraudSignals = (output.fraud_signals as FraudSignal[]) || [];
  const escalation = (output.escalation_risk as Record<string, unknown>) || {};
  const compliance = (output.compliance_concerns as ComplianceConcern[]) || [];
  const regulatory = (output.regulatory_mentions as string[]) || [];
  const intervention = output.intervention_recommendation as string | undefined;
  const interventionReasoning = output.intervention_reasoning as string | undefined;
  const riskLabel = output.risk_summary_label as string | undefined;

  const escalationScore = escalation.score_1_10 as number | undefined;
  const escalationIndicators = (escalation.indicators as string[]) || [];

  return (
    <div className="space-y-4">
      {/* Risk summary banner */}
      <Card className={`rounded-2xl ${
        riskLabel === "critical_compliance_breach" || riskLabel === "high_risk"
          ? "border-red-200 bg-red-50/40"
          : riskLabel === "medium_risk"
          ? "border-amber-200 bg-amber-50/40"
          : "border-emerald-200 bg-emerald-50/30"
      }`}>
        <CardContent className="p-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              {riskLabel === "no_risk" || riskLabel === "low_risk" ? (
                <div className="bg-emerald-100 rounded-full p-2.5">
                  <ShieldCheck className="size-5 text-emerald-700" />
                </div>
              ) : (
                <div className={`rounded-full p-2.5 ${
                  riskLabel === "medium_risk" ? "bg-amber-100" : "bg-red-100"
                }`}>
                  <ShieldAlert className={`size-5 ${
                    riskLabel === "medium_risk" ? "text-amber-700" : "text-red-700"
                  }`} />
                </div>
              )}
              <div>
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">Risk Summary</div>
                <Badge className={`${RISK_LABEL_TONE[riskLabel || "low_risk"] || RISK_LABEL_TONE.low_risk} font-medium`}>
                  {(riskLabel || "—").replace(/_/g, " ")}
                </Badge>
              </div>
            </div>
            {intervention && (
              <div>
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-0.5">Recommended Intervention</div>
                <Badge className={`${INTERVENTION_TONE[intervention] || INTERVENTION_TONE.none} font-medium`}>
                  {intervention.replace(/_/g, " ")}
                </Badge>
              </div>
            )}
          </div>
          {interventionReasoning && (
            <p className="text-sm text-slate-700 mt-3 leading-relaxed bg-white/70 rounded-lg p-3 border border-slate-100">
              {interventionReasoning}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Escalation risk gauge */}
      {escalationScore != null && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
              <AlertTriangle className="size-4 text-orange-600" />
              <span>Escalation Risk</span>
              <span className="ml-auto text-lg font-bold text-slate-800">{escalationScore}/10</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Progress
              value={escalationScore * 10}
              className={`h-2 ${escalationScore >= 7 ? "[&>div]:bg-red-500" : escalationScore >= 4 ? "[&>div]:bg-amber-500" : "[&>div]:bg-emerald-500"}`}
            />
            {escalationIndicators.length > 0 && (
              <div className="mt-3">
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1.5">Indicators</div>
                <div className="flex flex-wrap gap-1.5">
                  {escalationIndicators.map((ind, i) => (
                    <Badge key={i} variant="outline" className="bg-orange-50 text-orange-700 border-orange-200 font-normal text-[11px]">
                      {ind}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {escalation.recommended_action && (
              <p className="text-sm text-slate-600 mt-3 italic">→ {String(escalation.recommended_action)}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Fraud signals table */}
      {fraudSignals.length > 0 && (
        <Card className="rounded-2xl border-red-200/60 bg-red-50/20">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-red-800">
              <AlertOctagon className="size-4" />
              <span>Fraud Signals</span>
              <Badge variant="outline" className="ml-auto bg-white text-red-700 border-red-200 font-normal text-[10px]">
                {fraudSignals.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {fraudSignals.map((fs, i) => (
                <div key={i} className="bg-white border border-red-100 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="text-sm font-medium text-slate-800">{fs.signal || "—"}</div>
                    {fs.severity && (
                      <Badge variant="outline" className={`${SEVERITY_TONE[fs.severity] || SEVERITY_TONE.low} font-normal text-[10px] flex-shrink-0`}>
                        {fs.severity}
                      </Badge>
                    )}
                  </div>
                  {fs.evidence && (
                    <p className="text-xs text-slate-500 italic">"{fs.evidence}"</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Compliance concerns */}
      {compliance.length > 0 && (
        <Card className="rounded-2xl border-amber-200/60 bg-amber-50/20">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-amber-800">
              <Gavel className="size-4" />
              <span>Compliance Concerns</span>
              <Badge variant="outline" className="ml-auto bg-white text-amber-700 border-amber-200 font-normal text-[10px]">
                {compliance.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {compliance.map((c, i) => (
                <div key={i} className="bg-white border border-amber-100 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="text-sm font-medium text-slate-800">{(c.type || "—").replace(/_/g, " ")}</div>
                    {c.severity && (
                      <Badge variant="outline" className={`${SEVERITY_TONE[c.severity] || SEVERITY_TONE.low} font-normal text-[10px] flex-shrink-0`}>
                        {c.severity}
                      </Badge>
                    )}
                  </div>
                  {c.evidence && (
                    <p className="text-xs text-slate-500 italic">"{c.evidence}"</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Regulatory mentions */}
      {regulatory.filter(r => r !== "none").length > 0 && (
        <Card className="rounded-2xl border-red-200 bg-red-50/30">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-red-800">
              <Megaphone className="size-4" />
              <span>Regulatory Mentions</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {regulatory.filter(r => r !== "none").map((r, i) => (
                <Badge key={i} className="bg-red-100 text-red-700 border-red-200 font-medium">
                  {r.replace(/_/g, " ")}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* All-clear empty state */}
      {fraudSignals.length === 0 && compliance.length === 0 && regulatory.filter(r => r !== "none").length === 0 && (
        <Card className="rounded-2xl border-emerald-200 bg-emerald-50/30">
          <CardContent className="p-5 flex items-center gap-3">
            <ShieldCheck className="size-5 text-emerald-600" />
            <div>
              <div className="text-sm font-medium text-emerald-900">No fraud, compliance, or regulatory signals detected.</div>
              <div className="text-xs text-emerald-700/80 mt-0.5">This call appears clean from a risk perspective.</div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
