import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  CheckCircle2, XCircle, AlertTriangle, HelpCircle,
  User, MapPin, Phone, Bike, FileText, PhoneCall,
} from "lucide-react";

interface Props {
  identityVerificationOutput: Record<string, unknown>;
  informationExtractionOutput: Record<string, unknown>;
}

type CheckStatus = "good" | "warn" | "bad" | "unknown";

const statusForCheck = (status?: string): CheckStatus => {
  const s = (status || "").toLowerCase();
  if (s === "verified" || s === "own" || s === "self" || s === "consistent_with_application" ||
      s === "close_family" || s === "not_yet_delivered" || s === "within_30_days")
    return "good";
  if (s === "partial" || s === "non_relative" || s === "monnai_mismatch" || s === "third_party" ||
      s === "rented_short_residence" || s === "loan_cancelled" || s === "loan_not_taken" ||
      s === "refinance_mismatch" || s === "only_enquiry" || s === "dowry_purpose" ||
      s === "30_plus_days_ago" || s === "driver_not_co_app")
    return "bad";
  if (s === "refused" || s === "not_asked" || s === "")
    return "unknown";
  return "warn";
};

const ICONS = { good: CheckCircle2, warn: AlertTriangle, bad: XCircle, unknown: HelpCircle };
const COLORS: Record<CheckStatus, { icon: string; bg: string; text: string; label: string }> = {
  good:    { icon: "text-emerald-600", bg: "bg-emerald-50",  text: "text-emerald-700", label: "OK" },
  warn:    { icon: "text-amber-600",   bg: "bg-amber-50",    text: "text-amber-700",   label: "Caution" },
  bad:     { icon: "text-red-600",     bg: "bg-red-50",      text: "text-red-700",     label: "Risk" },
  unknown: { icon: "text-slate-400",   bg: "bg-slate-50",    text: "text-slate-500",   label: "Not asked" },
};

interface CheckRowProps {
  icon: typeof User;
  label: string;
  status: CheckStatus;
  value?: string;
  notes?: string;
  flags?: string[];
}

const CheckRow = ({ icon: Icon, label, status, value, notes, flags }: CheckRowProps) => {
  const StatusIcon = ICONS[status];
  const c = COLORS[status];
  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border ${c.bg} border-slate-100`}>
      <Icon className={`size-4 mt-0.5 flex-shrink-0 text-slate-600`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <span className="text-sm font-medium text-slate-800">{label}</span>
          <Badge variant="outline" className={`bg-white ${c.text} text-[10px] font-normal flex-shrink-0`}>
            <StatusIcon className={`size-3 mr-1 ${c.icon}`} />
            {value || c.label}
          </Badge>
        </div>
        {notes && <p className="text-xs text-slate-600 mt-1 italic">{notes}</p>}
        {flags && flags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {flags.map((f, i) => (
              <Badge key={i} variant="outline" className="bg-red-50 text-red-700 border-red-200 text-[10px] font-normal">
                {f}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export const IdentityCheckView = ({ identityVerificationOutput, informationExtractionOutput }: Props) => {
  const name        = (identityVerificationOutput?.name_check               as Record<string, unknown>) || {};
  const address     = (identityVerificationOutput?.address_check            as Record<string, unknown>) || {};
  const mobile      = (identityVerificationOutput?.mobile_ownership_check   as Record<string, unknown>) || {};
  const vehicle     = (identityVerificationOutput?.vehicle_check            as Record<string, unknown>) || {};
  const loan        = (identityVerificationOutput?.loan_check               as Record<string, unknown>) || {};
  const callback    = (identityVerificationOutput?.callback_check           as Record<string, unknown>) || {};
  const consistency = (identityVerificationOutput?.identity_consistency_1_10 as number | undefined) ?? null;
  const biggestConcern = identityVerificationOutput?.biggest_concern as string | undefined;

  const extracted = (informationExtractionOutput?.extracted_info as Record<string, unknown>) || {};
  const callerType = informationExtractionOutput?.caller_type as string | undefined;
  const callerTypeConfidence = informationExtractionOutput?.caller_type_confidence_1_10 as number | undefined;
  const callerTypeEvidence = informationExtractionOutput?.caller_type_evidence as string | undefined;

  // Build the flags list per check
  const addressFlags: string[] = [];
  if (address.flag_rented_under_1_year) addressFlags.push("rented < 1 year");

  const mobileFlags: string[] = [];
  if (mobile.flag_tenure_under_3_months) mobileFlags.push("tenure < 3 months");

  const vehicleFlags: string[] = [];
  if (vehicle.flag_vehicle_delivered_before_login) vehicleFlags.push("delivered 30+ days pre-login");
  if (vehicle.flag_product_mismatch) vehicleFlags.push("product mismatch (2W↔3W)");

  const callbackFlags: string[] = [];
  if (callback.flag_call_back_suspicious) callbackFlags.push("callback before verification");

  return (
    <div className="space-y-4">
      {/* Caller-type auto-detection */}
      <Card className="rounded-2xl border-slate-200 bg-gradient-to-br from-slate-50 to-white">
        <CardContent className="p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="bg-blue-100 rounded-full p-2">
              <User className="size-4 text-blue-700" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">
                Caller-type auto-detection
              </div>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-base font-semibold text-slate-900">{callerType || "Unknown"}</span>
                {callerTypeConfidence != null && (
                  <span className="text-xs text-slate-500">confidence {callerTypeConfidence}/10</span>
                )}
              </div>
              {callerTypeEvidence && (
                <p className="text-xs text-slate-500 italic mt-1">"{callerTypeEvidence}"</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Overall identity consistency */}
      {consistency != null && (
        <Card className="rounded-2xl border-slate-200">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-slate-700">Overall identity consistency</span>
              <span className="text-2xl font-bold text-slate-900">{consistency}<span className="text-sm text-slate-400">/10</span></span>
            </div>
            <Progress
              value={consistency * 10}
              className={`h-2 ${
                consistency >= 8 ? "[&>div]:bg-emerald-500"
                : consistency >= 5 ? "[&>div]:bg-amber-500"
                                   : "[&>div]:bg-red-500"
              }`}
            />
            {biggestConcern && biggestConcern !== "none — clean" && (
              <p className="text-xs text-amber-700 mt-2">Biggest concern: {biggestConcern}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* The 6 checks */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <CheckRow
          icon={User}
          label="Name verification"
          status={statusForCheck(name.status as string)}
          value={name.status as string}
          notes={name.notes as string}
        />
        <CheckRow
          icon={MapPin}
          label="Address verification"
          status={statusForCheck(address.status as string)}
          value={address.status as string}
          notes={address.residing_duration_months ? `Residing for ${address.residing_duration_months} months` : undefined}
          flags={addressFlags}
        />
        <CheckRow
          icon={Phone}
          label="Mobile ownership"
          status={statusForCheck(mobile.status as string)}
          value={mobile.status as string}
          notes={mobile.relationship as string}
          flags={mobileFlags}
        />
        <CheckRow
          icon={Bike}
          label="Vehicle delivery + usage"
          status={statusForCheck(vehicle.delivery_status as string)}
          value={`${vehicle.delivery_status || "—"} · used by ${vehicle.usage_status || "—"}`}
          flags={vehicleFlags}
        />
        <CheckRow
          icon={FileText}
          label="Loan consistency"
          status={statusForCheck(loan.status as string)}
          value={loan.status as string}
          notes={loan.notes as string}
        />
        <CheckRow
          icon={PhoneCall}
          label="Callback timing"
          status={callback.flag_call_back_suspicious ? "bad" : callback.requested_callback ? "warn" : "good"}
          value={callback.requested_callback ? "Requested" : "Not requested"}
          flags={callbackFlags}
        />
      </div>

      {/* Stated information extracted from the call */}
      {Object.keys(extracted).length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-slate-700">
              <FileText className="size-4 text-slate-500" />
              <span>Information stated on the call</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {Object.entries(extracted).map(([k, v]) => (
                <div key={k} className="bg-slate-50/70 border border-slate-100 rounded px-3 py-2">
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-0.5">
                    {k.replace(/_/g, " ")}
                  </div>
                  <div className="text-sm text-slate-800 break-words">{String(v) || "—"}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
