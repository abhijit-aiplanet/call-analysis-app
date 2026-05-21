import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  MessageCircle, Users, AlertTriangle, ClipboardCheck, ArrowRight,
} from "lucide-react";

interface PerUtterance {
  idx?: number;
  speaker?: string;
  speaker_role?: string;
  behavior_tag?: string;
  evidence?: string;
}

interface Props {
  output: Record<string, unknown>;
}

const BEHAVIOR_TONE: Record<string, string> = {
  cooperative:          "bg-emerald-100 text-emerald-700 border-emerald-200",
  neutral:              "bg-slate-100 text-slate-600 border-slate-200",
  hesitant:             "bg-amber-100 text-amber-700 border-amber-200",
  fumbling:             "bg-amber-100 text-amber-700 border-amber-200",
  evasive:              "bg-orange-100 text-orange-700 border-orange-200",
  rehearsed:            "bg-orange-100 text-orange-700 border-orange-200",
  irate:                "bg-red-100 text-red-700 border-red-200",
  defensive:            "bg-red-100 text-red-700 border-red-200",
  confused:             "bg-blue-100 text-blue-700 border-blue-200",
  rushed_through:       "bg-amber-100 text-amber-700 border-amber-200",
  contradictory:        "bg-red-100 text-red-700 border-red-200",
  prompted_by_third_party: "bg-red-100 text-red-700 border-red-200",
};

const ENGAGEMENT_TONE: Record<string, string> = {
  fully_cooperative:    "bg-emerald-100 text-emerald-700 border-emerald-200",
  reluctant:            "bg-amber-100 text-amber-700 border-amber-200",
  selectively_evasive:  "bg-orange-100 text-orange-700 border-orange-200",
  hostile:              "bg-red-100 text-red-700 border-red-200",
  silent:               "bg-slate-100 text-slate-600 border-slate-200",
};

const TRAJECTORY_ICON: Record<string, string> = {
  stable:        "→",
  improving:     "↗",
  deteriorating: "↘",
  volatile:      "↕",
};

const OVERALL_LABEL_TONE: Record<string, string> = {
  clean_cooperative:            "bg-emerald-100 text-emerald-700 border-emerald-200",
  lightly_hesitant:             "bg-amber-50 text-amber-700 border-amber-200",
  evasive_but_no_third_party:   "bg-orange-100 text-orange-700 border-orange-200",
  third_party_dominated:        "bg-red-100 text-red-700 border-red-200",
  hostile_refusal:              "bg-red-100 text-red-700 border-red-200",
  no_meaningful_dialogue:       "bg-slate-100 text-slate-600 border-slate-200",
};

export const ConversationView = ({ output }: Props) => {
  const perUtt = (output?.per_utterance as PerUtterance[]) || [];
  const engagement = (output?.subject_engagement as Record<string, unknown>) || {};
  const thirdParty = (output?.third_party_voice_detection as Record<string, unknown>) || {};
  const fumbling   = (output?.fumbling_on_identity as Record<string, unknown>) || {};
  const scriptAdh  = (output?.agent_script_adherence as Record<string, unknown>) || {};
  const overallLabel = output?.overall_call_label as string | undefined;

  return (
    <div className="space-y-4">
      {/* Overall call behavior label */}
      {overallLabel && (
        <Card className="rounded-2xl border-slate-200 bg-gradient-to-br from-slate-50 to-white">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="bg-purple-100 rounded-full p-2">
                <MessageCircle className="size-4 text-purple-700" />
              </div>
              <div className="flex-1">
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">
                  Overall conversation profile
                </div>
                <Badge className={`mt-1 font-medium ${OVERALL_LABEL_TONE[overallLabel] || "bg-slate-100 text-slate-700"}`}>
                  {overallLabel.replace(/_/g, " ")}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top row: engagement + third-party voice + fumbling */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Subject engagement */}
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
              <Users className="size-4 text-slate-600" />
              <span>Engagement</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {engagement.state && (
              <Badge className={`${ENGAGEMENT_TONE[String(engagement.state)] || "bg-slate-100 text-slate-700"} font-medium`}>
                {String(engagement.state).replace(/_/g, " ")}
              </Badge>
            )}
            {engagement.trajectory && (
              <div className="text-xs text-slate-600 mt-2">
                trajectory {TRAJECTORY_ICON[String(engagement.trajectory)] || "→"} {String(engagement.trajectory)}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Third-party voice */}
        <Card className={`rounded-2xl ${thirdParty.detected ? "border-red-200 bg-red-50/40" : "border-slate-200"}`}>
          <CardHeader className="pb-2">
            <CardTitle className={`flex items-center gap-2.5 text-sm font-semibold ${thirdParty.detected ? "text-red-700" : ""}`}>
              <AlertTriangle className="size-4" />
              <span>3rd-party voice</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge className={`${thirdParty.detected ? "bg-red-100 text-red-700 border-red-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"} font-medium`}>
              {thirdParty.detected ? "Detected" : "Not detected"}
            </Badge>
            {thirdParty.detected && (
              <div className="text-xs text-slate-600 mt-2">
                confidence {String(thirdParty.confidence_1_10 ?? "—")}/10
                {thirdParty.first_detected_at_utterance_idx != null && (
                  <span> · first at utt #{String(thirdParty.first_detected_at_utterance_idx)}</span>
                )}
              </div>
            )}
            {thirdParty.description && (
              <p className="text-xs text-slate-700 mt-1.5 italic">{String(thirdParty.description)}</p>
            )}
          </CardContent>
        </Card>

        {/* Fumbling on identity */}
        <Card className={`rounded-2xl ${fumbling.detected ? "border-amber-200 bg-amber-50/40" : "border-slate-200"}`}>
          <CardHeader className="pb-2">
            <CardTitle className={`flex items-center gap-2.5 text-sm font-semibold ${fumbling.detected ? "text-amber-700" : ""}`}>
              <AlertTriangle className="size-4" />
              <span>Identity fumbling</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge className={`${fumbling.detected ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"} font-medium`}>
              {fumbling.detected ? `Detected · ${String(fumbling.severity || "")}` : "Not detected"}
            </Badge>
            {fumbling.detected && Array.isArray(fumbling.which_fields) && (fumbling.which_fields as unknown[]).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {(fumbling.which_fields as string[]).map((f, i) => (
                  <Badge key={i} variant="outline" className="bg-white text-amber-700 border-amber-200 font-mono text-[10px]">
                    {f}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Agent script adherence */}
      <Card className="rounded-2xl border-slate-200">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
            <ClipboardCheck className="size-4 text-blue-600" />
            <span>RCU agent script adherence</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex items-center gap-2">
              {scriptAdh.opening_script_followed ? (
                <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">✓ Opening script followed</Badge>
              ) : (
                <Badge className="bg-amber-100 text-amber-700 border-amber-200">✗ Opening script skipped</Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {scriptAdh.identity_verification_attempted ? (
                <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">✓ Identity verification attempted</Badge>
              ) : (
                <Badge className="bg-amber-100 text-amber-700 border-amber-200">✗ No identity verification</Badge>
              )}
            </div>
          </div>
          {scriptAdh.notes && (
            <p className="text-xs text-slate-600 italic mt-2">{String(scriptAdh.notes)}</p>
          )}
        </CardContent>
      </Card>

      {/* Per-utterance behavior strip */}
      {perUtt.length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Per-utterance behavior</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1">
              {perUtt.slice(0, 80).map((u, i) => {
                const tone = BEHAVIOR_TONE[u.behavior_tag || "neutral"] || "bg-slate-100 text-slate-600";
                return (
                  <div
                    key={i}
                    title={`#${i} [${u.speaker_role}] ${u.behavior_tag} — ${u.evidence || ""}`}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium border ${tone} cursor-help`}
                  >
                    {u.behavior_tag?.slice(0, 6) || "—"}
                  </div>
                );
              })}
              {perUtt.length > 80 && (
                <span className="text-[10px] text-slate-400 self-center ml-2">+{perUtt.length - 80} more</span>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
