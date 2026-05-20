import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { DollarSign, Clock, Mic, Brain, Layers } from "lucide-react";
import type { UnifiedCost, SentimentAggregate, STTCost } from "./types";

const fmtUSD = (n: number, digits = 6) =>
  `$${n.toFixed(digits)}`;

const fmtCents = (n: number) => `${(n * 100).toFixed(4)}¢`;

interface CostBreakdownProps {
  unified: UnifiedCost;
  sttCost: STTCost;
  sentiment: SentimentAggregate;
  audioMinutes: number;
}

export const CostBreakdown = ({ unified, sttCost, sentiment, audioMinutes }: CostBreakdownProps) => {
  const sttPct = unified.stage_cost_share_pct.stt;
  const sentPct = unified.stage_cost_share_pct.sentiment;

  return (
    <div className="space-y-4">
      {/* Headline */}
      <Card className="rounded-xl border-emerald-200 bg-emerald-50/30 hover:shadow-lg transition-all">
        <CardContent className="p-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1">
                Total Pipeline Cost
              </div>
              <div className="text-2xl font-bold text-emerald-700">{fmtUSD(unified.total_usd)}</div>
              <div className="text-xs text-slate-500 mt-0.5">for this call</div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1">
                Cost per Minute of Audio
              </div>
              <div className="text-2xl font-bold text-slate-800">
                {unified.cost_per_minute_audio_usd != null
                  ? fmtUSD(unified.cost_per_minute_audio_usd, 6)
                  : "—"}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {unified.cost_per_minute_audio_usd != null && (
                  <>≈ {fmtCents(unified.cost_per_minute_audio_usd)} /min</>
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1">
                Audio Length
              </div>
              <div className="text-2xl font-bold text-slate-800">
                {audioMinutes.toFixed(2)} min
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {sttCost.audio_seconds.toFixed(1)} s
              </div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1">
                Wall Time
              </div>
              <div className="text-2xl font-bold text-slate-800">
                {unified.total_wall_time_s.toFixed(1)} s
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {(audioMinutes * 60 / Math.max(unified.total_wall_time_s, 1)).toFixed(1)}× real-time
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stage Split */}
      <Card className="rounded-xl border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-3 text-base font-semibold">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-2">
              <Layers className="size-4 text-blue-600" />
            </div>
            <span>Cost by Pipeline Stage</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* STT */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <Mic className="size-4 text-purple-600" />
                <span className="text-sm font-medium text-slate-700">STT (ElevenLabs Scribe v2)</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-slate-900">{fmtUSD(unified.stt_usd)}</span>
                <Badge variant="outline" className="text-xs font-normal">{sttPct.toFixed(1)}%</Badge>
              </div>
            </div>
            <Progress value={sttPct} className="h-2 bg-slate-100" />
            <div className="text-xs text-slate-500 mt-1.5 ml-6">
              base @ ${sttCost.rate_per_hour_base.toFixed(2)}/hr
              {sttCost.cost_usd_keyterms > 0 && (
                <> + keyterms @ ${sttCost.rate_per_hour_keyterms.toFixed(2)}/hr</>
              )}
              {sttCost.cost_usd_keyterms > 0 && (
                <> (+{fmtUSD(sttCost.cost_usd_keyterms)} for keyterm bias)</>
              )}
            </div>
          </div>

          {/* Sentiment */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <Brain className="size-4 text-emerald-600" />
                <span className="text-sm font-medium text-slate-700">Multi-Agent Sentiment (gpt-4o-mini)</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-slate-900">{fmtUSD(unified.sentiment_usd)}</span>
                <Badge variant="outline" className="text-xs font-normal">{sentPct.toFixed(1)}%</Badge>
              </div>
            </div>
            <Progress value={sentPct} className="h-2 bg-slate-100" />
            <div className="text-xs text-slate-500 mt-1.5 ml-6">
              5 specialists ({fmtUSD(unified.specialists_usd)}) + synthesizer ({fmtUSD(unified.synthesizer_usd)})
              <span className="text-slate-400"> · {sentiment.aggregate_cost.total_tokens.toLocaleString()} tokens</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Per-Agent Breakdown */}
      <Card className="rounded-xl border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-3 text-base font-semibold">
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-2">
              <Brain className="size-4 text-purple-600" />
            </div>
            <span>Per-Agent Cost (Multi-Agent System)</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[
              { key: "intelligence", label: "Call Intelligence",       data: sentiment.specialists.intelligence.cost },
              { key: "emotion",      label: "Emotion & Tonality",      data: sentiment.specialists.emotion.cost },
              { key: "performance",  label: "Agent Performance",       data: sentiment.specialists.performance.cost },
              { key: "resolution",   label: "Resolution & Pain Points",data: sentiment.specialists.resolution.cost },
              { key: "risk",         label: "Risk & Compliance",       data: sentiment.specialists.risk.cost },
              { key: "synthesizer",  label: "Synthesizer",             data: sentiment.synthesizer.cost,
                isSynth: true },
            ].map(({ key, label, data, isSynth }) => (
              <div key={key} className={`grid grid-cols-12 gap-3 items-center px-3 py-2 rounded-lg ${
                  isSynth ? "bg-amber-50/40 border border-amber-100" : "hover:bg-slate-50"
                }`}>
                <div className="col-span-4 text-sm font-medium text-slate-700">{label}</div>
                <div className="col-span-3 text-xs text-slate-500">
                  in: {data.prompt_tokens.toLocaleString()} / out: {data.completion_tokens.toLocaleString()}
                </div>
                <div className="col-span-3 text-xs text-slate-500">
                  <Clock className="inline size-3 mr-1" />
                  {(data.wall_time_s ?? 0).toFixed(1)}s
                </div>
                <div className="col-span-2 text-right text-sm font-mono font-semibold text-slate-900">
                  {fmtUSD(data.cost_usd_total)}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Rate Card */}
      <Card className="rounded-xl border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-3 text-base font-semibold">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2">
              <DollarSign className="size-4 text-amber-600" />
            </div>
            <span>Rate Card (verified May 2026)</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="flex justify-between p-2 rounded bg-slate-50">
              <span className="text-slate-600">Scribe v2 base</span>
              <span className="font-mono font-semibold">${unified.rate_card.elevenlabs_scribe_v2_base_per_hour}/hr</span>
            </div>
            <div className="flex justify-between p-2 rounded bg-slate-50">
              <span className="text-slate-600">Keyterms surcharge</span>
              <span className="font-mono font-semibold">+${unified.rate_card.elevenlabs_keyterms_surcharge_per_hour}/hr</span>
            </div>
            <div className="flex justify-between p-2 rounded bg-slate-50">
              <span className="text-slate-600">gpt-4o-mini input</span>
              <span className="font-mono font-semibold">${unified.rate_card.azure_gpt4o_mini_per_M_input_usd}/M tokens</span>
            </div>
            <div className="flex justify-between p-2 rounded bg-slate-50">
              <span className="text-slate-600">gpt-4o-mini output</span>
              <span className="font-mono font-semibold">${unified.rate_card.azure_gpt4o_mini_per_M_output_usd}/M tokens</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Extrapolations */}
      {unified.cost_per_minute_audio_usd != null && (
        <Card className="rounded-xl border-slate-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">At Scale (using this call's per-minute rate)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              {[
                ["1,000 min (~200 calls)", unified.cost_per_minute_audio_usd * 1000],
                ["10,000 min (~2K calls)", unified.cost_per_minute_audio_usd * 10000],
                ["100K min (~20K calls)",  unified.cost_per_minute_audio_usd * 100000],
                ["1M min (~200K calls)",   unified.cost_per_minute_audio_usd * 1000000],
              ].map(([label, val]) => (
                <div key={label as string} className="p-3 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="text-xs text-slate-500 mb-1">{label}</div>
                  <div className="text-base font-semibold text-slate-900 font-mono">
                    ${(val as number).toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
