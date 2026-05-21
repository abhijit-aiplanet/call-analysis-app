import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  ShieldAlert, AlertOctagon, ShieldCheck, AlertTriangle, Quote,
} from "lucide-react";

interface Props {
  output: Record<string, unknown>;
}

const SEVERITY_TONE: Record<string, { bg: string; text: string; border: string }> = {
  low:      { bg: "bg-slate-100",  text: "text-slate-600",  border: "border-slate-200" },
  medium:   { bg: "bg-amber-100",  text: "text-amber-700",  border: "border-amber-200" },
  high:     { bg: "bg-orange-100", text: "text-orange-700", border: "border-orange-200" },
  critical: { bg: "bg-red-100",    text: "text-red-700",    border: "border-red-200" },
};

const PATTERN_LABEL: Record<string, string> = {
  third_party_use:                 "Third-party (non-relative) uses the vehicle",
  third_party_mobile:              "Third-party (non-relative) owns the mobile",
  third_party_prompting:           "Third-party voice prompting on call",
  third_party_attending:           "Third-party (non-relative) attended the call",
  third_party_use_family:          "Close family uses the vehicle",
  third_party_mobile_family:       "Close family owns the mobile",
  third_party_attending_family:    "Close family attended the call",
  loan_not_taken:                  "Applicant denies taking this loan",
  loan_cancelled:                  "Loan cancellation / return mentioned",
  refused_to_share_info:           "Refused to share information (evasive)",
  refused_irate:                   "Refused (irate, service-issue driven)",
  info_mismatch_name:              "Stated name doesn't match application",
  info_mismatch_dob:               "DOB mismatch / fumbling",
  info_mismatch_address:           "Address mismatch / fumbling",
  info_mismatch_employment:        "Employment / employer mismatch",
  call_back_suspicious:            "Callback requested before verification",
  wrong_number:                    "Wrong number — person doesn't know applicant",
  vehicle_delivered_before_login:  "Vehicle delivered 30+ days before TC call",
  monnai_name_mismatch:            "Monnai name not recognised",
  monnai_name_third_party:         "Monnai name belongs to non-relative",
  mobile_belongs_to_monnai:        "Mobile number is in another (Monnai) name",
  mobile_tenure_under_3_months:    "Mobile usage < 3 months (new number)",
  rented_under_1_year:             "Rented residence < 1 year",
  cash_transaction_mention:        "Cash transactions outside official channels",
  otp_request_by_agent:            "Agent asking customer for OTP (irregular)",
  agent_pressure_tactics:          "Agent using pressure tactics",
  product_mismatch_2w_3w:          "Product mismatch (2W ↔ 3W)",
  dowry_marriage_purpose:          "Vehicle for marriage / dowry purpose",
  incomplete_information:          "Incomplete information gathered",
  only_enquiry:                    "Only enquiry — never bought",
  connected_no_response:           "Connected but no response (silent > 10s)",
  voice_dob_mismatch_suspicious:   "Voice / DOB fumbling (suspicious)",
  driver_not_co_applicant:         "Driver uses vehicle but isn't co-applicant",
  dealer_sourcing_influenced:      "Dealer influenced refusal to share info",
};

interface Pattern {
  pattern?: string;
  severity?: string;
  evidence_quote?: string;
  evidence_timestamp_s?: number | null;
  notes?: string;
}

export const RiskView = ({ output }: Props) => {
  const patterns           = (output?.patterns                  as Pattern[]) || [];
  const overallRisk        = (output?.overall_fraud_risk_1_10   as number | undefined);
  const highestSeverity    = output?.highest_severity_observed  as string | undefined;
  const shortSummary       = output?.short_summary              as string | undefined;

  const groupedBySeverity: Record<string, Pattern[]> = {};
  for (const p of patterns) {
    const sev = (p.severity || "low").toLowerCase();
    if (!groupedBySeverity[sev]) groupedBySeverity[sev] = [];
    groupedBySeverity[sev].push(p);
  }
  const severityOrder = ["critical", "high", "medium", "low"];

  return (
    <div className="space-y-4">
      {/* Overall fraud risk gauge */}
      <Card className={`rounded-2xl ${
        highestSeverity === "critical" ? "border-red-200 bg-red-50/40"
        : highestSeverity === "high"   ? "border-orange-200 bg-orange-50/40"
        : highestSeverity === "medium" ? "border-amber-200 bg-amber-50/40"
        : "border-emerald-200 bg-emerald-50/30"
      }`}>
        <CardContent className="p-5">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
            <div className="flex items-center gap-3">
              {patterns.length === 0 || highestSeverity === "none" ? (
                <div className="bg-emerald-100 rounded-full p-2.5">
                  <ShieldCheck className="size-5 text-emerald-700" />
                </div>
              ) : (
                <div className={`rounded-full p-2.5 ${
                  highestSeverity === "critical" ? "bg-red-100"
                  : highestSeverity === "high"   ? "bg-orange-100"
                  : "bg-amber-100"
                }`}>
                  <ShieldAlert className={`size-5 ${
                    highestSeverity === "critical" ? "text-red-700"
                    : highestSeverity === "high"   ? "text-orange-700"
                    : "text-amber-700"
                  }`} />
                </div>
              )}
              <div>
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">Fraud risk</div>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-slate-900">{overallRisk ?? "—"}</span>
                  <span className="text-base text-slate-400">/10</span>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {highestSeverity && (
                <Badge className={`${
                  highestSeverity === "critical" ? "bg-red-100 text-red-700 border-red-200"
                  : highestSeverity === "high"   ? "bg-orange-100 text-orange-700 border-orange-200"
                  : highestSeverity === "medium" ? "bg-amber-100 text-amber-700 border-amber-200"
                  : "bg-slate-100 text-slate-600 border-slate-200"
                } font-medium`}>
                  Severity: {highestSeverity}
                </Badge>
              )}
              <Badge variant="outline" className="bg-white">
                {patterns.length} pattern{patterns.length !== 1 ? "s" : ""} detected
              </Badge>
            </div>
          </div>
          {overallRisk != null && (
            <Progress
              value={overallRisk * 10}
              className={`h-2 ${
                overallRisk >= 8 ? "[&>div]:bg-red-500"
                : overallRisk >= 5 ? "[&>div]:bg-orange-500"
                : overallRisk >= 3 ? "[&>div]:bg-amber-500"
                                   : "[&>div]:bg-emerald-500"
              }`}
            />
          )}
          {shortSummary && (
            <p className="text-sm text-slate-700 mt-3 leading-relaxed">{shortSummary}</p>
          )}
        </CardContent>
      </Card>

      {/* All-clear empty state */}
      {patterns.length === 0 && (
        <Card className="rounded-2xl border-emerald-200 bg-emerald-50/30">
          <CardContent className="p-5 flex items-center gap-3">
            <ShieldCheck className="size-5 text-emerald-600" />
            <div>
              <div className="text-sm font-medium text-emerald-900">No fraud risk patterns detected.</div>
              <div className="text-xs text-emerald-700/80 mt-0.5">This call looks clean from a fraud-detection perspective.</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Patterns grouped by severity */}
      {severityOrder.map((sev) => {
        const inSev = groupedBySeverity[sev] || [];
        if (inSev.length === 0) return null;
        const tone = SEVERITY_TONE[sev] || SEVERITY_TONE.low;
        return (
          <Card key={sev} className={`rounded-2xl ${tone.border} ${tone.bg.replace("100", "50/40")}`}>
            <CardHeader className="pb-2">
              <CardTitle className={`flex items-center gap-2.5 text-sm font-semibold ${tone.text}`}>
                {sev === "critical" ? <AlertOctagon className="size-4" /> : <AlertTriangle className="size-4" />}
                <span className="capitalize">{sev}-severity patterns</span>
                <Badge variant="outline" className={`ml-auto bg-white ${tone.text} ${tone.border} font-normal text-[10px]`}>
                  {inSev.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {inSev.map((p, i) => (
                <div key={i} className="bg-white border border-slate-100 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2 mb-1.5 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800">
                        {PATTERN_LABEL[p.pattern || ""] || p.pattern || "—"}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono mt-0.5">{p.pattern}</div>
                    </div>
                    {p.evidence_timestamp_s != null && (
                      <Badge variant="outline" className="text-[10px] font-mono bg-slate-50 flex-shrink-0">
                        {Math.floor(p.evidence_timestamp_s / 60).toString().padStart(2, "0")}:
                        {Math.floor(p.evidence_timestamp_s % 60).toString().padStart(2, "0")}
                      </Badge>
                    )}
                  </div>
                  {p.evidence_quote && (
                    <div className="flex gap-2 items-start mt-1.5 bg-slate-50/70 rounded p-2">
                      <Quote className="size-3 text-slate-400 mt-1 flex-shrink-0" />
                      <p className="text-xs text-slate-700 italic">"{p.evidence_quote}"</p>
                    </div>
                  )}
                  {p.notes && (
                    <p className="text-xs text-slate-600 mt-1.5">{p.notes}</p>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
};
