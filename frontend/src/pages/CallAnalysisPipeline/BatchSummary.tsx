import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DollarSign, Clock, Layers, CheckCircle2, XCircle, BarChart3,
} from "lucide-react";
import type { BatchJob, BatchAggregateCost } from "./types";

const fmt$ = (n: number, digits = 4) => `$${n.toFixed(digits)}`;

interface BatchSummaryProps {
  job: BatchJob;
}

export const BatchSummary = ({ job }: BatchSummaryProps) => {
  const agg: BatchAggregateCost | null = job.aggregate_cost;
  if (!agg) return null;

  const speedup = agg.audio_minutes_per_wall_minute ?? 1;
  const wallMin = agg.wall_time_seconds / 60;

  return (
    <Card className="rounded-2xl border-emerald-200/70 bg-gradient-to-br from-emerald-50/40 to-white shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
          <div className="bg-emerald-100 rounded-lg p-2">
            <BarChart3 className="size-4 text-emerald-700" />
          </div>
          <span>Batch Summary</span>
          <Badge variant="outline" className="ml-auto bg-white text-[10px] font-mono">
            job {job.job_id.slice(0, 8)}…
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Top metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Metric
            icon={<Layers className="size-4 text-blue-600" />}
            label="Files processed"
            value={`${agg.completed_files}`}
            sub={agg.failed_files > 0 ? `${agg.failed_files} failed` : "all succeeded"}
            tone={agg.failed_files > 0 ? "warn" : "good"}
          />
          <Metric
            icon={<Clock className="size-4 text-purple-600" />}
            label="Total audio"
            value={`${agg.total_audio_minutes.toFixed(1)} min`}
            sub={`${agg.total_audio_hours.toFixed(2)} hrs`}
          />
          <Metric
            icon={<DollarSign className="size-4 text-emerald-700" />}
            label="Total pipeline cost"
            value={fmt$(agg.total_pipeline_usd, 4)}
            sub={agg.avg_cost_per_minute_audio_usd != null
              ? `${fmt$(agg.avg_cost_per_minute_audio_usd, 6)} / min audio`
              : undefined}
            big
          />
          <Metric
            icon={<Clock className="size-4 text-slate-500" />}
            label="Wall time"
            value={wallMin >= 1 ? `${wallMin.toFixed(1)} min` : `${agg.wall_time_seconds.toFixed(1)} s`}
            sub={`${speedup.toFixed(1)}× real-time`}
          />
        </div>

        {/* Cost breakdown by stage */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <CostRow
            label="STT (ElevenLabs Scribe v2)"
            usd={agg.total_stt_usd}
            pct={(agg.total_stt_usd / Math.max(agg.total_pipeline_usd, 1e-9)) * 100}
            tone="purple"
          />
          <CostRow
            label="Multi-Agent Sentiment"
            usd={agg.total_sentiment_usd}
            pct={(agg.total_sentiment_usd / Math.max(agg.total_pipeline_usd, 1e-9)) * 100}
            tone="emerald"
          />
        </div>

        {/* Per-call avg */}
        <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-xs text-slate-600 flex items-center justify-between flex-wrap gap-2">
          <span>
            Avg <strong className="text-slate-800 font-semibold">{fmt$(agg.avg_cost_per_call_usd, 4)}</strong> / call
            {" · "}
            {agg.avg_cost_per_minute_audio_usd != null && (
              <>Avg <strong className="text-slate-800 font-semibold">{fmt$(agg.avg_cost_per_minute_audio_usd, 6)}</strong> / min</>
            )}
          </span>
          <span className="text-slate-500">
            Extrap. to 10K calls ≈ <strong className="text-slate-800 font-mono">{fmt$(agg.avg_cost_per_call_usd * 10000, 2)}</strong>
          </span>
        </div>
      </CardContent>
    </Card>
  );
};

interface MetricProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn" | "neutral";
  big?: boolean;
}
const Metric = ({ icon, label, value, sub, tone, big }: MetricProps) => (
  <div className={`p-3 rounded-lg bg-white border ${
    tone === "good" ? "border-emerald-100"
    : tone === "warn" ? "border-amber-100"
                      : "border-slate-100"
  }`}>
    <div className="flex items-center gap-1.5 mb-1.5">
      {icon}
      <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">{label}</span>
    </div>
    <div className={`font-bold text-slate-900 ${big ? "text-2xl" : "text-lg"}`}>{value}</div>
    {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
  </div>
);

interface CostRowProps {
  label: string;
  usd: number;
  pct: number;
  tone: "purple" | "emerald";
}
const CostRow = ({ label, usd, pct, tone }: CostRowProps) => (
  <div className="p-3 rounded-lg bg-white border border-slate-100">
    <div className="flex items-center justify-between mb-1.5">
      <span className="text-xs font-medium text-slate-700">{label}</span>
      <span className="text-sm font-mono font-semibold text-slate-900">{fmt$(usd, 4)}</span>
    </div>
    <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
      <div
        className={`h-full ${tone === "purple" ? "bg-purple-500" : "bg-emerald-500"}`}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
    <div className="text-[10px] text-slate-500 mt-1">{pct.toFixed(1)}% of total</div>
  </div>
);
