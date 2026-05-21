import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { IndianRupee, Clock, Mic, Brain, Layers } from "lucide-react";
import type { UnifiedCost, VerificationAggregate, STTCost } from "./types";
import { inr, inrScale, USD_TO_INR } from "@/lib/currency";

interface CostBreakdownProps {
  unified: UnifiedCost;
  sttCost: STTCost;
  verification: VerificationAggregate;
  audioMinutes: number;
  sttVendor?: string; // e.g. "Soniox stt-async-v4" or "ElevenLabs Scribe v2"
}

const SPECIALIST_LABELS: Record<string, string> = {
  information_extraction: "Information Extraction (also caller-type detect)",
  identity_verification:  "Identity Verification",
  fraud_risk:             "Fraud Risk Detection",
  conversation_behavior:  "Conversation Behavior",
};

export const CostBreakdown = ({ unified, sttCost, verification, audioMinutes, sttVendor }: CostBreakdownProps) => {
  const sttPct = unified.stage_cost_share_pct.stt;
  const verPct = unified.stage_cost_share_pct.verification;
  const vendor = sttVendor || "Soniox stt-async-v4";
  const isSoniox = vendor.toLowerCase().includes("soniox");

  return (
    <div className="space-y-4">
      {/* Headline */}
      <Card className="rounded-2xl border-emerald-200 bg-emerald-50/30">
        <CardContent className="p-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1">
                Total Pipeline Cost
              </div>
              <div className="text-2xl font-bold text-emerald-700">{inr(unified.total_usd)}</div>
              <div className="text-xs text-slate-500 mt-0.5">for this call</div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1">
                Cost per Minute of Audio
              </div>
              <div className="text-2xl font-bold text-slate-800">
                {inr(unified.cost_per_minute_audio_usd ?? undefined)}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">audio-time rate</div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1">
                Audio Length
              </div>
              <div className="text-2xl font-bold text-slate-800">{audioMinutes.toFixed(2)} min</div>
              <div className="text-xs text-slate-500 mt-0.5">{sttCost.audio_seconds.toFixed(1)} s</div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1">Wall Time</div>
              <div className="text-2xl font-bold text-slate-800">{unified.total_wall_time_s.toFixed(1)} s</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {(audioMinutes * 60 / Math.max(unified.total_wall_time_s, 1)).toFixed(1)}× real-time
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stage Split */}
      <Card className="rounded-2xl border-slate-200">
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
                <span className="text-sm font-medium text-slate-700">STT ({vendor})</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-slate-900">{inr(unified.stt_usd)}</span>
                <Badge variant="outline" className="text-xs font-normal">{sttPct.toFixed(1)}%</Badge>
              </div>
            </div>
            <Progress value={sttPct} className="h-2 bg-slate-100" />
            <div className="text-xs text-slate-500 mt-1.5 ml-6">
              base @ {inr(sttCost.rate_per_hour_base)}/hr
              {sttCost.cost_usd_keyterms > 0 && (
                <> + keyterms @ {inr(sttCost.rate_per_hour_keyterms)}/hr (+{inr(sttCost.cost_usd_keyterms)})</>
              )}
            </div>
          </div>

          {/* Verification */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <Brain className="size-4 text-emerald-600" />
                <span className="text-sm font-medium text-slate-700">Multi-Agent Verification (gpt-4o-mini)</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-slate-900">{inr(unified.verification_usd)}</span>
                <Badge variant="outline" className="text-xs font-normal">{verPct.toFixed(1)}%</Badge>
              </div>
            </div>
            <Progress value={verPct} className="h-2 bg-slate-100" />
            <div className="text-xs text-slate-500 mt-1.5 ml-6">
              specialists ({inr(unified.specialists_usd)}) + decision ({inr(unified.decision_agent_usd)})
              <span className="text-slate-400"> · {verification.aggregate_cost.total_tokens.toLocaleString()} tokens</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Per-Agent Breakdown */}
      <Card className="rounded-2xl border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-3 text-base font-semibold">
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-2">
              <Brain className="size-4 text-purple-600" />
            </div>
            <span>Per-Agent Cost</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {verification.triage && (
              <div className="grid grid-cols-12 gap-3 items-center px-3 py-2 rounded-lg bg-blue-50/40 border border-blue-100">
                <div className="col-span-4 text-sm font-medium text-slate-700">
                  Triage Agent (pre-flight)
                  {verification.triage.short_circuited && (
                    <Badge variant="outline" className="ml-2 text-[9px] bg-white">short-circuit</Badge>
                  )}
                </div>
                <div className="col-span-3 text-xs text-slate-500">
                  in: {verification.triage.cost.prompt_tokens.toLocaleString()} / out: {verification.triage.cost.completion_tokens.toLocaleString()}
                </div>
                <div className="col-span-3 text-xs text-slate-500">
                  <Clock className="inline size-3 mr-1" />
                  {(verification.triage.cost.wall_time_s ?? 0).toFixed(1)}s
                </div>
                <div className="col-span-2 text-right text-sm font-mono font-semibold text-slate-900">
                  {inr(verification.triage.cost.cost_usd_total)}
                </div>
              </div>
            )}
            {Object.entries(verification.specialists).map(([key, payload]) => payload && (
              <div key={key} className="grid grid-cols-12 gap-3 items-center px-3 py-2 rounded-lg hover:bg-slate-50">
                <div className="col-span-4 text-sm font-medium text-slate-700">
                  {SPECIALIST_LABELS[key] || key}
                </div>
                <div className="col-span-3 text-xs text-slate-500">
                  in: {payload.cost.prompt_tokens.toLocaleString()} / out: {payload.cost.completion_tokens.toLocaleString()}
                </div>
                <div className="col-span-3 text-xs text-slate-500">
                  <Clock className="inline size-3 mr-1" />
                  {(payload.cost.wall_time_s ?? 0).toFixed(1)}s
                </div>
                <div className="col-span-2 text-right text-sm font-mono font-semibold text-slate-900">
                  {inr(payload.cost.cost_usd_total)}
                </div>
              </div>
            ))}
            <div className="grid grid-cols-12 gap-3 items-center px-3 py-2 rounded-lg bg-amber-50/40 border border-amber-100">
              <div className="col-span-4 text-sm font-medium text-slate-700">Decision Agent (Disposition Classifier)</div>
              <div className="col-span-3 text-xs text-slate-500">
                in: {verification.decision_agent.cost.prompt_tokens.toLocaleString()} / out: {verification.decision_agent.cost.completion_tokens.toLocaleString()}
              </div>
              <div className="col-span-3 text-xs text-slate-500">
                <Clock className="inline size-3 mr-1" />
                {(verification.decision_agent.cost.wall_time_s ?? 0).toFixed(1)}s
              </div>
              <div className="col-span-2 text-right text-sm font-mono font-semibold text-slate-900">
                {inr(verification.decision_agent.cost.cost_usd_total)}
              </div>
            </div>
            {verification.reflection && (verification.reflection.cost.cost_usd_total > 0 || verification.reflection.applied) && (
              <div className="grid grid-cols-12 gap-3 items-center px-3 py-2 rounded-lg bg-purple-50/40 border border-purple-100">
                <div className="col-span-4 text-sm font-medium text-slate-700">
                  Reflection Agent (self-critique)
                  {verification.reflection.applied && (
                    <Badge variant="outline" className="ml-2 text-[9px] bg-white">applied</Badge>
                  )}
                </div>
                <div className="col-span-3 text-xs text-slate-500">
                  in: {verification.reflection.cost.prompt_tokens.toLocaleString()} / out: {verification.reflection.cost.completion_tokens.toLocaleString()}
                </div>
                <div className="col-span-3 text-xs text-slate-500">
                  <Clock className="inline size-3 mr-1" />
                  {(verification.reflection.cost.wall_time_s ?? 0).toFixed(1)}s
                </div>
                <div className="col-span-2 text-right text-sm font-mono font-semibold text-slate-900">
                  {inr(verification.reflection.cost.cost_usd_total)}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Rate Card */}
      <Card className="rounded-2xl border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-3 text-base font-semibold">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2">
              <IndianRupee className="size-4 text-amber-600" />
            </div>
            <span>Rate Card</span>
            <span className="ml-auto text-[10px] font-normal text-slate-400">1 USD ≈ ₹{USD_TO_INR}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            {isSoniox ? (
              <div className="flex justify-between p-2 rounded bg-slate-50">
                <span className="text-slate-600">Soniox stt-async-v4</span>
                <span className="font-mono font-semibold">
                  {inr(unified.rate_card.soniox_stt_async_v4_per_hour ?? 0.10)}/hr
                </span>
              </div>
            ) : (
              <>
                <div className="flex justify-between p-2 rounded bg-slate-50">
                  <span className="text-slate-600">Scribe v2 base</span>
                  <span className="font-mono font-semibold">{inr(unified.rate_card.elevenlabs_scribe_v2_base_per_hour)}/hr</span>
                </div>
                <div className="flex justify-between p-2 rounded bg-slate-50">
                  <span className="text-slate-600">Keyterms surcharge</span>
                  <span className="font-mono font-semibold">+{inr(unified.rate_card.elevenlabs_keyterms_surcharge_per_hour)}/hr</span>
                </div>
              </>
            )}
            <div className="flex justify-between p-2 rounded bg-slate-50">
              <span className="text-slate-600">gpt-4o-mini input</span>
              <span className="font-mono font-semibold">{inr(unified.rate_card.azure_gpt4o_mini_per_M_input_usd)}/M tokens</span>
            </div>
            <div className="flex justify-between p-2 rounded bg-slate-50">
              <span className="text-slate-600">gpt-4o-mini output</span>
              <span className="font-mono font-semibold">{inr(unified.rate_card.azure_gpt4o_mini_per_M_output_usd)}/M tokens</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Extrapolations */}
      {unified.cost_per_minute_audio_usd != null && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">At Scale (using this call's per-minute rate)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              {[
                ["1,000 min (~200 calls)",     unified.cost_per_minute_audio_usd * 1_000],
                ["10,000 min (~2K calls)",     unified.cost_per_minute_audio_usd * 10_000],
                ["1,00,000 min (~20K calls)",  unified.cost_per_minute_audio_usd * 1_00_000],
                ["10,00,000 min (~2L calls)",  unified.cost_per_minute_audio_usd * 10_00_000],
              ].map(([label, val]) => (
                <div key={label as string} className="p-3 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="text-xs text-slate-500 mb-1">{label}</div>
                  <div className="text-base font-semibold text-slate-900 font-mono">
                    {inrScale(val as number)}
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
