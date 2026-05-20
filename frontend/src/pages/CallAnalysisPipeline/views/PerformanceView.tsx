import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  CheckCircle2, XCircle, MinusCircle, ClipboardCheck,
  ThumbsUp, TrendingUp, Award,
} from "lucide-react";

interface Props {
  output: Record<string, unknown>;
}

interface StandardEntry { yes_no_na?: string; evidence?: string; }

const YN_TONE: Record<string, { cls: string; Icon: typeof CheckCircle2 }> = {
  Yes: { cls: "bg-emerald-100 text-emerald-700 border-emerald-200", Icon: CheckCircle2 },
  No:  { cls: "bg-red-100 text-red-700 border-red-200",            Icon: XCircle      },
  "N/A": { cls: "bg-slate-100 text-slate-500 border-slate-200",    Icon: MinusCircle  },
};

const prettyStandard = (k: string) =>
  k.replace(/_/g, " ").replace(/(^|\s)\w/g, (m) => m.toUpperCase());

export const PerformanceView = ({ output }: Props) => {
  const scorecard = (output.scorecard as Record<string, StandardEntry>) || {};
  const strengths = (output.strengths as string[]) || [];
  const improvements = (output.areas_for_improvement as string[]) || [];
  const overall = output.overall_rating_1_10 as number | undefined;
  const expertise = output.category_expertise as string | undefined;
  const empathy = output.agent_empathy_1_10 as number | undefined;
  const professionalism = output.agent_professionalism_1_10 as number | undefined;

  const standardsList = Object.entries(scorecard);
  const yesCount = standardsList.filter(([, v]) => v?.yes_no_na === "Yes").length;
  const noCount  = standardsList.filter(([, v]) => v?.yes_no_na === "No").length;
  const naCount  = standardsList.filter(([, v]) => v?.yes_no_na === "N/A").length;
  const applicable = yesCount + noCount;

  return (
    <div className="space-y-4">
      {/* Overall scorecard header */}
      <Card className="rounded-2xl border-slate-200 bg-gradient-to-br from-slate-50 to-white">
        <CardContent className="p-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1">Overall Rating</div>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-bold text-emerald-700">
                  {overall ?? "—"}
                </span>
                <span className="text-base text-slate-400">/10</span>
              </div>
              {overall != null && <Progress value={overall * 10} className="h-1.5 mt-2" />}
            </div>
            <div>
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1">Empathy</div>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold text-slate-800">{empathy ?? "—"}</span>
                <span className="text-sm text-slate-400">/10</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1">Professionalism</div>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold text-slate-800">{professionalism ?? "—"}</span>
                <span className="text-sm text-slate-400">/10</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1">Expertise</div>
              <Badge
                className={`mt-1 ${
                  expertise === "high"   ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                  : expertise === "low"  ? "bg-red-100 text-red-700 border-red-200"
                                         : "bg-amber-100 text-amber-700 border-amber-200"
                } font-medium`}
              >
                <Award className="size-3 mr-1" />
                {expertise || "—"}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Scorecard rows */}
      {standardsList.length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
              <ClipboardCheck className="size-4 text-slate-600" />
              <span>11-Point Quality Scorecard</span>
              <Badge variant="outline" className="ml-auto text-xs font-normal">
                {yesCount} / {applicable} met · {naCount} N/A
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {standardsList.map(([k, v]) => {
                const yn = v?.yes_no_na || "N/A";
                const tone = YN_TONE[yn] || YN_TONE["N/A"];
                const { Icon } = tone;
                return (
                  <div
                    key={k}
                    className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 transition-colors"
                  >
                    <Icon className={`size-4 mt-0.5 flex-shrink-0 ${
                      yn === "Yes" ? "text-emerald-600"
                      : yn === "No" ? "text-red-600"
                                    : "text-slate-400"
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <span className="text-sm font-medium text-slate-800">{prettyStandard(k)}</span>
                        <Badge variant="outline" className={`${tone.cls} font-normal text-[10px] flex-shrink-0`}>
                          {yn}
                        </Badge>
                      </div>
                      {v?.evidence && (
                        <p className="text-xs text-slate-500 mt-1 italic">"{v.evidence}"</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Strengths + improvements */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {strengths.length > 0 && (
          <Card className="rounded-2xl border-emerald-200/60 bg-emerald-50/30">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-emerald-800">
                <ThumbsUp className="size-4" />
                <span>Strengths</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {strengths.map((s, i) => (
                  <li key={i} className="text-sm text-slate-700 flex gap-2 items-start">
                    <CheckCircle2 className="size-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                    <span className="leading-relaxed">{s}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
        {improvements.length > 0 && (
          <Card className="rounded-2xl border-amber-200/60 bg-amber-50/30">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-amber-800">
                <TrendingUp className="size-4" />
                <span>Areas for Improvement</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {improvements.map((s, i) => (
                  <li key={i} className="text-sm text-slate-700 flex gap-2 items-start">
                    <div className="size-3.5 mt-0.5 rounded-full border-2 border-amber-500 flex-shrink-0" />
                    <span className="leading-relaxed">{s}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};
