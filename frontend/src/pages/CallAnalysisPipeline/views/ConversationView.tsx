import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  MessageCircle, Users, AlertTriangle, ClipboardCheck,
  CheckCircle2, XCircle, MicOff, Volume2,
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

/** Tally a count of behavior tags so we can show a compact distribution. */
function tallyBehaviors(perUtt: PerUtterance[]): { tag: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const u of perUtt) {
    const tag = u.behavior_tag || "neutral";
    counts[tag] = (counts[tag] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

export const ConversationView = ({ output }: Props) => {
  const perUtt = (output?.per_utterance as PerUtterance[]) || [];
  const engagement = (output?.subject_engagement as Record<string, unknown>) || {};
  const thirdParty = (output?.third_party_voice_detection as Record<string, unknown>) || {};
  const fumbling   = (output?.fumbling_on_identity as Record<string, unknown>) || {};
  const scriptAdh  = (output?.agent_script_adherence as Record<string, unknown>) || {};
  const overallLabel = output?.overall_call_label as string | undefined;

  const tally = tallyBehaviors(perUtt);
  const totalUtt = perUtt.length;

  return (
    <div className="space-y-4">
      {/* Overall conversation profile — hero card */}
      {overallLabel && (
        <Card className="rounded-2xl border-slate-200 bg-gradient-to-br from-purple-50/50 via-white to-slate-50/40 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="bg-purple-100 rounded-full p-2.5">
                <MessageCircle className="size-5 text-purple-700" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">
                  Overall conversation profile
                </div>
                <Badge
                  className={`mt-1 font-medium text-sm px-2.5 py-1 ${
                    OVERALL_LABEL_TONE[overallLabel] || "bg-slate-100 text-slate-700"
                  }`}
                >
                  {overallLabel.replace(/_/g, " ")}
                </Badge>
              </div>
              {totalUtt > 0 && (
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">utterances analyzed</div>
                  <div className="text-2xl font-bold text-slate-800 tabular-nums">{totalUtt}</div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top row: engagement + third-party voice + fumbling */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Subject engagement */}
        <SignalCard
          title="Engagement"
          icon={<Users className="size-4 text-slate-600" />}
          status={engagement.state ? "info" : "neutral"}
        >
          {engagement.state && (
            <Badge
              className={`${ENGAGEMENT_TONE[String(engagement.state)] || "bg-slate-100 text-slate-700"} font-medium text-xs`}
            >
              {String(engagement.state).replace(/_/g, " ")}
            </Badge>
          )}
          {engagement.trajectory && (
            <div className="text-xs text-slate-600 mt-2 flex items-center gap-1">
              <span className="text-slate-400">trajectory</span>
              <span className="text-base">{TRAJECTORY_ICON[String(engagement.trajectory)] || "→"}</span>
              <span className="font-medium">{String(engagement.trajectory).replace(/_/g, " ")}</span>
            </div>
          )}
        </SignalCard>

        {/* Third-party voice */}
        <SignalCard
          title="3rd-party voice"
          icon={
            thirdParty.detected
              ? <AlertTriangle className="size-4 text-red-600" />
              : <Volume2 className="size-4 text-slate-600" />
          }
          status={thirdParty.detected ? "alert" : "good"}
        >
          <Badge
            className={
              thirdParty.detected
                ? "bg-red-100 text-red-700 border-red-200 font-medium"
                : "bg-emerald-50 text-emerald-700 border-emerald-200 font-medium"
            }
          >
            {thirdParty.detected ? "Detected" : "Not detected"}
          </Badge>
          {thirdParty.detected && (
            <div className="text-xs text-slate-600 mt-2">
              confidence{" "}
              <span className="font-mono font-semibold text-slate-800">
                {String(thirdParty.confidence_1_10 ?? "—")}/10
              </span>
              {thirdParty.first_detected_at_utterance_idx != null && (
                <span className="text-slate-400"> · utt #{String(thirdParty.first_detected_at_utterance_idx)}</span>
              )}
            </div>
          )}
          {thirdParty.description ? (
            <p className="text-xs text-slate-700 mt-1.5 italic line-clamp-3">
              {String(thirdParty.description)}
            </p>
          ) : null}
        </SignalCard>

        {/* Fumbling on identity */}
        <SignalCard
          title="Identity fumbling"
          icon={
            fumbling.detected
              ? <AlertTriangle className="size-4 text-amber-600" />
              : <MicOff className="size-4 text-slate-600" />
          }
          status={fumbling.detected ? "warn" : "good"}
        >
          <Badge
            className={
              fumbling.detected
                ? "bg-amber-100 text-amber-700 border-amber-200 font-medium"
                : "bg-emerald-50 text-emerald-700 border-emerald-200 font-medium"
            }
          >
            {fumbling.detected ? `Detected · ${String(fumbling.severity || "")}` : "Not detected"}
          </Badge>
          {fumbling.detected && Array.isArray(fumbling.which_fields) && (fumbling.which_fields as unknown[]).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {(fumbling.which_fields as string[]).map((f, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className="bg-white text-amber-700 border-amber-200 font-mono text-[10px]"
                >
                  {f}
                </Badge>
              ))}
            </div>
          )}
        </SignalCard>
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            <ScriptCheck
              ok={!!scriptAdh.opening_script_followed}
              labelOk="Opening script followed"
              labelBad="Opening script skipped"
            />
            <ScriptCheck
              ok={!!scriptAdh.identity_verification_attempted}
              labelOk="Identity verification attempted"
              labelBad="No identity verification"
            />
          </div>
          {scriptAdh.notes ? (
            <p className="text-xs text-slate-600 italic mt-3 leading-relaxed">{String(scriptAdh.notes)}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* Per-utterance behavior — proper timeline + distribution */}
      {perUtt.length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
              <Users className="size-4 text-slate-600" />
              <span>Per-utterance behavior</span>
              <Badge variant="outline" className="ml-auto text-[10px] font-normal">
                {perUtt.length} utterances
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Distribution row */}
            <div className="space-y-1.5">
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">
                Distribution
              </div>
              <div className="flex flex-wrap gap-1.5">
                {tally.map(({ tag, count }) => {
                  const tone = BEHAVIOR_TONE[tag] || "bg-slate-100 text-slate-600 border-slate-200";
                  const pct = Math.round((count / totalUtt) * 100);
                  return (
                    <div
                      key={tag}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs ${tone}`}
                      title={`${count} / ${totalUtt} (${pct}%)`}
                    >
                      <span className="font-bold tabular-nums">{count}</span>
                      <span className="font-medium">{tag.replace(/_/g, " ")}</span>
                      <span className="opacity-60 tabular-nums">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Sequence strip — one bar per utterance, hover reveals details */}
            <div className="space-y-1.5">
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">
                Sequence (left = start of call)
              </div>
              <div className="flex items-stretch gap-[2px] flex-wrap">
                {perUtt.map((u, i) => {
                  const tag = u.behavior_tag || "neutral";
                  const tone = BEHAVIOR_TONE[tag] || "bg-slate-100 text-slate-600 border-slate-200";
                  const bg = tone.split(" ")[0]; // first class is bg
                  return (
                    <div
                      key={i}
                      title={`#${i} · ${u.speaker_role || "?"} · ${tag}${u.evidence ? ` — ${u.evidence}` : ""}`}
                      className={`h-6 w-2.5 rounded-sm border border-white/40 ${bg} hover:scale-y-125 transition-transform cursor-help`}
                    />
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

// ─── Small building blocks ──────────────────────────────────────────────────

interface SignalCardProps {
  title: string;
  icon: React.ReactNode;
  status: "alert" | "warn" | "good" | "info" | "neutral";
  children?: React.ReactNode;
}

const STATUS_BORDER: Record<SignalCardProps["status"], string> = {
  alert:   "border-red-200 bg-red-50/40",
  warn:    "border-amber-200 bg-amber-50/40",
  good:    "border-slate-200",
  info:    "border-slate-200",
  neutral: "border-slate-200",
};

const SignalCard = ({ title, icon, status, children }: SignalCardProps) => (
  <Card className={`rounded-2xl ${STATUS_BORDER[status]}`}>
    <CardHeader className="pb-2">
      <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
        {icon}
        <span>{title}</span>
      </CardTitle>
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);

const ScriptCheck = ({ ok, labelOk, labelBad }: { ok: boolean; labelOk: string; labelBad: string }) => (
  <div
    className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
      ok ? "bg-emerald-50/60 border-emerald-200" : "bg-amber-50/60 border-amber-200"
    }`}
  >
    {ok ? (
      <CheckCircle2 className="size-4 text-emerald-600 flex-shrink-0" />
    ) : (
      <XCircle className="size-4 text-amber-600 flex-shrink-0" />
    )}
    <span className={`text-sm font-medium ${ok ? "text-emerald-800" : "text-amber-800"}`}>
      {ok ? labelOk : labelBad}
    </span>
  </div>
);
