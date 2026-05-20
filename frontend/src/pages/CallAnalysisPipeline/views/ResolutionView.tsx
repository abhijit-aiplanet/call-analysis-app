import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Target, AlertTriangle, PhoneCall, Heart,
  Lightbulb, CheckCircle2,
} from "lucide-react";

interface Props {
  output: Record<string, unknown>;
}

const STATUS_TONE: Record<string, string> = {
  yes:        "bg-emerald-100 text-emerald-700 border-emerald-200",
  partial:    "bg-amber-100 text-amber-700 border-amber-200",
  no:         "bg-red-100 text-red-700 border-red-200",
  "not_applicable": "bg-slate-100 text-slate-500 border-slate-200",
};

const URGENCY_TONE: Record<string, string> = {
  high:    "bg-red-100 text-red-700 border-red-200",
  medium:  "bg-amber-100 text-amber-700 border-amber-200",
  low:     "bg-slate-100 text-slate-600 border-slate-200",
};

const SENTIMENT_TONE: Record<string, string> = {
  positive: "bg-emerald-100 text-emerald-700 border-emerald-200",
  negative: "bg-red-100 text-red-700 border-red-200",
  neutral:  "bg-slate-100 text-slate-600 border-slate-200",
  mixed:    "bg-amber-100 text-amber-700 border-amber-200",
};

export const ResolutionView = ({ output }: Props) => {
  const painPoints = (output.customer_pain_points as string[]) || [];
  const underlying = (output.underlying_needs as string[]) || [];
  const unaddressed = (output.unaddressed_needs as string[]) || [];
  const resolution = (output.resolution as Record<string, unknown>) || {};
  const callback = (output.callback_required as Record<string, unknown>) || {};
  const satisfaction = output.satisfaction_inference_1_10 as number | undefined;
  const finalSent = (output.final_customer_sentiment as Record<string, unknown>) || {};
  const nbas = (output.next_best_actions_for_business as string[]) || [];

  return (
    <div className="space-y-4">
      {/* Headline row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Resolution status */}
        <Card className="rounded-2xl border-slate-200">
          <CardContent className="p-4">
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-2">Resolution</div>
            <Badge className={`${STATUS_TONE[String(resolution.status || "no")] || STATUS_TONE.no} font-medium px-3 py-1`}>
              {String(resolution.status || "—")}
            </Badge>
            {resolution.quality_1_10 != null && (
              <div className="mt-2">
                <div className="text-xs text-slate-500">quality {String(resolution.quality_1_10)}/10</div>
                <Progress value={(resolution.quality_1_10 as number) * 10} className="h-1.5 mt-1" />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Satisfaction */}
        <Card className="rounded-2xl border-slate-200">
          <CardContent className="p-4">
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-2">Customer Satisfaction</div>
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-bold text-slate-800">{satisfaction ?? "—"}</span>
              <span className="text-base text-slate-400">/10</span>
            </div>
            {satisfaction != null && <Progress value={satisfaction * 10} className="h-1.5 mt-2" />}
          </CardContent>
        </Card>

        {/* Callback */}
        <Card className="rounded-2xl border-slate-200">
          <CardContent className="p-4">
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-2">Callback</div>
            <div className="flex items-center gap-2">
              <PhoneCall className={`size-4 ${callback.needed === "yes" ? "text-red-600" : "text-slate-400"}`} />
              <Badge variant="outline" className={`font-medium ${
                callback.needed === "yes" ? "bg-red-50 text-red-700 border-red-200" : "bg-slate-50 text-slate-600"
              }`}>
                {callback.needed === "yes" ? "Required" : "Not needed"}
              </Badge>
            </div>
            {callback.needed === "yes" && callback.urgency != null && (
              <Badge variant="outline" className={`mt-2 ${URGENCY_TONE[String(callback.urgency)] || URGENCY_TONE.low} font-normal text-[10px]`}>
                urgency: {String(callback.urgency)}
              </Badge>
            )}
            {callback.estimated_window && (
              <div className="text-xs text-slate-500 mt-1.5">{String(callback.estimated_window)}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Final sentiment with nuance */}
      {Object.keys(finalSent).length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
              <Heart className="size-4 text-pink-600" />
              <span>Final Customer Sentiment</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Badge className={`${SENTIMENT_TONE[String(finalSent.label || "neutral")] || SENTIMENT_TONE.neutral} font-medium px-3 py-1`}>
              {String(finalSent.label || "—")}
            </Badge>
            {finalSent.nuance && (
              <p className="text-sm text-slate-600 italic">"{String(finalSent.nuance)}"</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Pain points */}
      {painPoints.length > 0 && (
        <Card className="rounded-2xl border-red-200/50 bg-red-50/20">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-red-800">
              <AlertTriangle className="size-4" />
              <span>Customer Pain Points</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {painPoints.map((p, i) => (
                <li key={i} className="text-sm text-slate-700 flex gap-2 items-start">
                  <span className="size-1.5 rounded-full bg-red-500 mt-2 flex-shrink-0" />
                  <span className="leading-relaxed">{p}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Underlying vs Unaddressed needs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {underlying.length > 0 && (
          <Card className="rounded-2xl border-slate-200">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-slate-700">
                <Target className="size-4 text-blue-600" />
                <span>Underlying Needs</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5">
                {underlying.map((s, i) => (
                  <li key={i} className="text-sm text-slate-700 flex gap-2 items-start">
                    <span className="size-1.5 rounded-full bg-blue-500 mt-2 flex-shrink-0" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
        {unaddressed.length > 0 && (
          <Card className="rounded-2xl border-amber-200/60 bg-amber-50/30">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-amber-800">
                <AlertTriangle className="size-4" />
                <span>Unaddressed Needs</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5">
                {unaddressed.map((s, i) => (
                  <li key={i} className="text-sm text-slate-700 flex gap-2 items-start">
                    <span className="size-1.5 rounded-full bg-amber-500 mt-2 flex-shrink-0" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Next Best Actions */}
      {nbas.length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
              <Lightbulb className="size-4 text-emerald-600" />
              <span>Recommended Follow-up Actions</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2">
              {nbas.map((a, i) => (
                <li key={i} className="flex gap-3 text-sm text-slate-700">
                  <span className="flex-shrink-0 mt-0.5 size-5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-semibold border border-emerald-200 flex items-center justify-center">
                    {i + 1}
                  </span>
                  <span className="leading-relaxed">{a}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      {/* Reasoning footer */}
      {resolution.reasoning && (
        <Card className="rounded-2xl border-slate-100 bg-slate-50/50">
          <CardContent className="p-4">
            <div className="flex gap-2 items-start">
              <CheckCircle2 className="size-4 text-slate-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-slate-600 leading-relaxed italic">{String(resolution.reasoning)}</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
