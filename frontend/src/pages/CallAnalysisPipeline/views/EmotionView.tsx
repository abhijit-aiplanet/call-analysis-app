import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
} from "recharts";
import { Activity, ArrowRight, AlertCircle, Smile, Heart, User } from "lucide-react";

interface Props {
  output: Record<string, unknown>;
}

interface PerUtterance {
  idx?: number;
  emotion?: string;
  intensity_1_10?: number;
  tonality?: string;
  brief_evidence?: string;
  speaker?: string;
}

const TRAJECTORY_TONE = (t?: string) => {
  if (!t) return "bg-slate-100 text-slate-600";
  if (t === "improving") return "bg-emerald-100 text-emerald-700 border-emerald-200";
  if (t === "declining") return "bg-red-100 text-red-700 border-red-200";
  if (t === "stable")    return "bg-blue-100 text-blue-700 border-blue-200";
  return "bg-amber-100 text-amber-700 border-amber-200";
};

const EMOTION_COLOR: Record<string, string> = {
  joy:           "bg-emerald-100 text-emerald-700",
  satisfaction:  "bg-emerald-100 text-emerald-700",
  neutral:       "bg-slate-100 text-slate-700",
  warm_resolution: "bg-emerald-100 text-emerald-700",
  professional_neutral: "bg-blue-100 text-blue-700",
  surprise:      "bg-blue-100 text-blue-700",
  confusion:     "bg-amber-100 text-amber-700",
  anxiety:       "bg-amber-100 text-amber-700",
  frustration:   "bg-orange-100 text-orange-700",
  frustrated_resolved: "bg-orange-100 text-orange-700",
  frustrated_unresolved: "bg-red-100 text-red-700",
  anger:         "bg-red-100 text-red-700",
  fear:          "bg-purple-100 text-purple-700",
  sadness:       "bg-blue-100 text-blue-700",
  disgust:       "bg-red-100 text-red-700",
  hostile:       "bg-red-100 text-red-700",
};

const emotionToScore = (emotion?: string, intensity?: number): number => {
  const i = intensity ?? 5;
  const positive = ["joy", "satisfaction"];
  const negative = ["anger", "fear", "sadness", "disgust", "frustration", "anxiety"];
  if (positive.includes(emotion || "")) return i / 10;
  if (negative.includes(emotion || "")) return -i / 10;
  return 0;
};

export const EmotionView = ({ output }: Props) => {
  const perUtt = (output.per_utterance as PerUtterance[]) || [];
  const customerArc = (output.customer_arc as Record<string, unknown>) || {};
  const agentArc    = (output.agent_arc    as Record<string, unknown>) || {};
  const overall     = (output.overall_call_emotion as Record<string, unknown>) || {};

  // Build trajectory chart by splitting utterances into 6 equal segments
  const segments = 6;
  const segLabels = ["Open", "Q1", "Q2", "Q3", "Q4", "Close"];
  const chartData = segLabels.map((label, segIdx) => {
    const segSize = Math.max(1, Math.ceil(perUtt.length / segments));
    const sliceStart = segIdx * segSize;
    const slice = perUtt.slice(sliceStart, sliceStart + segSize);
    const customer = slice.filter((u) => (u.speaker || "").toLowerCase().includes("1") || (u.speaker || "").toLowerCase().includes("b") || (u.speaker || "").includes("customer"));
    const agent    = slice.filter((u) => !customer.includes(u));
    const avg = (arr: PerUtterance[]) =>
      arr.length === 0 ? 0 : arr.reduce((s, u) => s + emotionToScore(u.emotion, u.intensity_1_10), 0) / arr.length;
    return { segment: label, Customer: avg(customer), Agent: avg(agent) };
  });

  const inflections = (customerArc.key_inflection_points as Array<Record<string, unknown>>) || [];

  return (
    <div className="space-y-4">
      {/* Overall emotion + intensity */}
      {Object.keys(overall).length > 0 && (
        <Card className="rounded-2xl border-slate-200 bg-gradient-to-br from-slate-50 to-white">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2.5">
                <div className="bg-purple-100 rounded-full p-2">
                  <Heart className="size-4 text-purple-700" />
                </div>
                <div>
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">Overall Emotion</div>
                  <div className="text-base font-semibold text-slate-900">
                    {String(overall.label || "—").replace(/_/g, " ")}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 ml-auto">
                {overall.intensity_1_10 != null && (
                  <Badge variant="outline" className="bg-white">
                    Intensity {String(overall.intensity_1_10)}/10
                  </Badge>
                )}
                {overall.confidence_1_10 != null && (
                  <Badge variant="outline" className="bg-white text-slate-500">
                    Confidence {String(overall.confidence_1_10)}/10
                  </Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sentiment trajectory chart */}
      {perUtt.length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
              <Activity className="size-4 text-blue-600" />
              <span>Emotional Trajectory</span>
              <Badge variant="outline" className="ml-auto text-[10px] font-normal">
                {perUtt.length} utterances
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="segment" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <YAxis
                    domain={[-1, 1]}
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => v === 1 ? "Positive" : v === 0 ? "Neutral" : v === -1 ? "Negative" : ""}
                  />
                  <ReferenceLine y={0} stroke="#cbd5e1" strokeDasharray="4 4" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "white",
                      border: "1px solid #e2e8f0",
                      borderRadius: "8px",
                      fontSize: 12,
                    }}
                    formatter={(value: number, name) => {
                      const label = value > 0.3 ? "Positive" : value < -0.3 ? "Negative" : "Neutral";
                      return [`${label} (${value.toFixed(2)})`, name];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" />
                  <Line type="monotone" dataKey="Agent"    stroke="#2563eb" strokeWidth={2.5} dot={{ r: 4, fill: "#2563eb" }} activeDot={{ r: 6 }} />
                  <Line type="monotone" dataKey="Customer" stroke="#f59e0b" strokeWidth={2.5} dot={{ r: 4, fill: "#f59e0b" }} activeDot={{ r: 6 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Customer & Agent arcs side-by-side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {Object.keys(customerArc).length > 0 && (
          <Card className="rounded-2xl border-amber-200/50 bg-amber-50/20">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-amber-800">
                <Smile className="size-4" />
                <span>Customer Arc</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-slate-700">{String(customerArc.start_state || "—")}</span>
                <ArrowRight className="size-4 text-slate-400" />
                <span className="font-medium text-slate-700">{String(customerArc.end_state || "—")}</span>
              </div>
              {customerArc.trajectory && (
                <Badge variant="outline" className={`${TRAJECTORY_TONE(customerArc.trajectory as string)} font-normal`}>
                  trajectory: {String(customerArc.trajectory)}
                </Badge>
              )}
            </CardContent>
          </Card>
        )}
        {Object.keys(agentArc).length > 0 && (
          <Card className="rounded-2xl border-blue-200/50 bg-blue-50/20">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-blue-800">
                <User className="size-4" />
                <span>Agent Arc</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-slate-700">{String(agentArc.start_state || "—")}</span>
                <ArrowRight className="size-4 text-slate-400" />
                <span className="font-medium text-slate-700">{String(agentArc.end_state || "—")}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {agentArc.trajectory && (
                  <Badge variant="outline" className={`${TRAJECTORY_TONE(agentArc.trajectory as string)} font-normal`}>
                    trajectory: {String(agentArc.trajectory)}
                  </Badge>
                )}
                {agentArc.tonal_consistency && (
                  <Badge variant="outline" className="bg-white font-normal">
                    tone: {String(agentArc.tonal_consistency)}
                  </Badge>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Inflection points */}
      {inflections.length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
              <AlertCircle className="size-4 text-amber-600" />
              <span>Emotional Inflection Points</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {inflections.map((ip, i) => (
                <div key={i} className="flex gap-3 items-start bg-amber-50/40 border border-amber-100 rounded-lg p-3">
                  <Badge variant="outline" className="bg-white border-amber-200 text-amber-700 font-mono text-[10px] flex-shrink-0">
                    @utt {String(ip.at_idx ?? ip.at_utterance_idx ?? "?")}
                  </Badge>
                  <span className="text-sm text-slate-700">{String(ip.description || "")}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Per-utterance heatmap of emotions */}
      {perUtt.length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Per-Utterance Emotion Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1">
              {perUtt.slice(0, 60).map((u, i) => {
                const cls = EMOTION_COLOR[(u.emotion || "").toLowerCase()] || "bg-slate-100 text-slate-600";
                return (
                  <div
                    key={i}
                    title={`#${i}: ${u.emotion} (${u.intensity_1_10}/10) — ${u.brief_evidence || ""}`}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium ${cls} cursor-help`}
                  >
                    {u.emotion?.slice(0, 4) || "—"}
                  </div>
                );
              })}
              {perUtt.length > 60 && (
                <span className="text-[10px] text-slate-400 self-center ml-2">+{perUtt.length - 60} more</span>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
