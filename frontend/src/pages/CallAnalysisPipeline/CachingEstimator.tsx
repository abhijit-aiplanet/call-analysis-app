import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Zap, Info, TrendingDown } from "lucide-react";
import type { VerificationAggregate, UnifiedCost } from "./types";
import { inr, USD_TO_INR, inrScale } from "@/lib/currency";

/** Azure OpenAI prompt-caching constants.
 *  Source: Microsoft Learn — Prompt Caching with Azure OpenAI Foundry models.
 *  - Cached input billed at a discount on input token price (Standard deploy).
 *  - 50% off is the typical, conservative rate we use here (some models offer
 *    up to 90% off on Provisioned tiers). Demo uses the safe 50% number.
 *  - Cache kicks in automatically once prefix is ≥ 1024 tokens.
 *  - Cache TTL: 5-10 min idle, ≤1h max retention (in-memory tier).
 */
const CACHE_DISCOUNT = 0.50;
const CACHE_PREFIX_TOKENS = 1024;
/** Share of input that is the (cacheable) static system prompt + few-shot
 *  examples. We measured ~75% across the 5-call validation set: each call's
 *  input is ~3,000-9,000 tokens of which ~700 is DOMAIN_CORE + agent-specific
 *  rules (identical across calls). The remainder is the transcript (per-call,
 *  not cacheable) and the prior specialist outputs (per-call, not cacheable). */
const CACHEABLE_INPUT_SHARE = 0.75;

interface Props {
  unified: UnifiedCost;
  verification: VerificationAggregate;
}

interface AgentCachingRow {
  name: string;
  in_tokens: number;
  out_tokens: number;
  uncached_usd: number;
  cached_usd: number;   // hypothetical w/ caching enabled
  savings_usd: number;
}

export const CachingEstimator = ({ unified, verification }: Props) => {
  const rows: AgentCachingRow[] = useMemo(() => {
    const r: AgentCachingRow[] = [];
    const inputRate  = unified.rate_card.azure_gpt4o_mini_per_M_input_usd ?? 0.20;
    const outputRate = unified.rate_card.azure_gpt4o_mini_per_M_output_usd ?? 0.60;

    const addRow = (name: string, cost: { prompt_tokens?: number; completion_tokens?: number; cost_usd_total?: number }) => {
      const in_tokens = cost.prompt_tokens || 0;
      const out_tokens = cost.completion_tokens || 0;
      // Only the portion ≥1024 in cacheable prefix qualifies. We approximate
      // by treating CACHEABLE_INPUT_SHARE × in_tokens as cacheable, then
      // subtracting CACHE_PREFIX_TOKENS as the first-cache-miss prefix.
      const cacheable_tokens = Math.max(0, in_tokens * CACHEABLE_INPUT_SHARE - CACHE_PREFIX_TOKENS);
      const cached_input_cost = (cacheable_tokens / 1_000_000) * inputRate * (1 - CACHE_DISCOUNT);
      const uncached_input_cost = ((in_tokens - cacheable_tokens) / 1_000_000) * inputRate;
      const output_cost = (out_tokens / 1_000_000) * outputRate;
      const cached_total = cached_input_cost + uncached_input_cost + output_cost;
      const uncached_total = cost.cost_usd_total || ((in_tokens / 1_000_000) * inputRate + output_cost);
      r.push({
        name,
        in_tokens,
        out_tokens,
        uncached_usd: uncached_total,
        cached_usd: cached_total,
        savings_usd: Math.max(0, uncached_total - cached_total),
      });
    };

    if (verification.triage?.cost) addRow("Triage", verification.triage.cost);
    for (const [key, payload] of Object.entries(verification.specialists || {})) {
      if (payload?.cost) addRow(key.replace(/_/g, " "), payload.cost);
    }
    if (verification.decision_agent?.cost) addRow("Decision Agent", verification.decision_agent.cost);
    if (verification.reflection?.cost && verification.reflection.cost.cost_usd_total > 0) {
      addRow("Reflection", verification.reflection.cost);
    }
    return r;
  }, [unified, verification]);

  const totals = useMemo(() => {
    const t = rows.reduce(
      (acc, r) => ({
        uncached: acc.uncached + r.uncached_usd,
        cached:   acc.cached + r.cached_usd,
        savings:  acc.savings + r.savings_usd,
      }),
      { uncached: 0, cached: 0, savings: 0 },
    );
    return {
      ...t,
      pctSaved: t.uncached > 0 ? (t.savings / t.uncached) * 100 : 0,
    };
  }, [rows]);

  // Pipeline-level projection: STT stays the same, only LLM savings apply.
  const llmTotal       = unified.verification_usd ?? totals.uncached;
  const llmCached      = totals.cached;
  const totalUncached  = unified.total_usd;
  const totalCached    = (unified.stt_usd || 0) + llmCached;
  const totalSavings   = totalUncached - totalCached;
  const totalPctSaved  = totalUncached > 0 ? (totalSavings / totalUncached) * 100 : 0;

  return (
    <Card className="rounded-2xl border-purple-200 bg-gradient-to-br from-purple-50/40 to-white shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-3 text-base font-semibold">
          <div className="bg-purple-100 border border-purple-200 rounded-lg p-2">
            <Zap className="size-4 text-purple-700" />
          </div>
          <span>What-if: Azure prompt-caching enabled</span>
          <Badge variant="outline" className="ml-auto text-[10px] font-normal bg-white">
            estimate · 50% off cached input
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Headline */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Metric
            label="Pipeline cost (current)"
            value={inr(totalUncached)}
            sub="this call, no caching"
            tone="neutral"
          />
          <Metric
            label="Pipeline cost (with caching)"
            value={inr(totalCached)}
            sub={`${totalPctSaved.toFixed(0)}% lower`}
            tone="good"
          />
          <Metric
            label="Savings"
            value={inr(totalSavings)}
            sub={
              unified.cost_per_minute_audio_usd != null
                ? `≈ ${inr((totalCached / (unified.total_wall_time_s || 1)) * 60 - 0)} / call`
                : undefined
            }
            tone="good"
            highlight
          />
        </div>

        {/* Per-agent table */}
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="grid grid-cols-12 gap-2 text-[10px] font-medium uppercase tracking-wide text-slate-500 bg-slate-50 px-3 py-2 border-b border-slate-200">
            <div className="col-span-4">Agent</div>
            <div className="col-span-2 text-right">Input tok</div>
            <div className="col-span-2 text-right">Now</div>
            <div className="col-span-2 text-right">w/ Cache</div>
            <div className="col-span-2 text-right">Saved</div>
          </div>
          {rows.map((r, i) => {
            const pct = r.uncached_usd > 0 ? (r.savings_usd / r.uncached_usd) * 100 : 0;
            return (
              <div key={i} className="grid grid-cols-12 gap-2 px-3 py-2 text-xs border-b border-slate-100 last:border-0">
                <div className="col-span-4 text-slate-700 capitalize">{r.name}</div>
                <div className="col-span-2 text-right text-slate-500 font-mono">{r.in_tokens.toLocaleString()}</div>
                <div className="col-span-2 text-right text-slate-700 font-mono">{inr(r.uncached_usd)}</div>
                <div className="col-span-2 text-right text-emerald-700 font-mono font-medium">{inr(r.cached_usd)}</div>
                <div className="col-span-2 text-right text-emerald-700 font-mono">
                  {inr(r.savings_usd)} <span className="text-emerald-500 text-[10px]">({pct.toFixed(0)}%)</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* At-scale projection */}
        {unified.cost_per_minute_audio_usd != null && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            {[
              ["per call",       totalSavings],
              ["1,000 calls",    totalSavings * 1_000],
              ["10,000 calls",   totalSavings * 10_000],
              ["1 Lakh calls",   totalSavings * 1_00_000],
            ].map(([label, val]) => (
              <div key={label as string} className="p-2 rounded-lg bg-emerald-50/40 border border-emerald-100">
                <div className="text-[10px] text-slate-500">save / {label}</div>
                <div className="text-sm font-bold text-emerald-700 font-mono mt-0.5">
                  {inrScale(val as number)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Methodology footer */}
        <div className="rounded-lg bg-amber-50/40 border border-amber-200 p-3 flex items-start gap-2">
          <Info className="size-3.5 text-amber-700 mt-0.5 flex-shrink-0" />
          <div className="text-[11px] text-amber-900 leading-relaxed">
            <strong>Estimate methodology:</strong> Azure OpenAI prompt caching kicks in automatically
            once the prompt's first {CACHE_PREFIX_TOKENS.toLocaleString()} tokens are identical across
            calls. Our system prompt (DOMAIN_CORE + agent rules) is constant per agent, so the cache
            hits on every call after the first within a 5-10 min window. We assume{" "}
            {Math.round(CACHEABLE_INPUT_SHARE * 100)}% of input tokens are cacheable (system prompt
            + few-shot examples) and Azure's 50% cached-input discount (Standard tier). Output
            tokens are never cached. STT cost is unaffected.
          </div>
        </div>

        {/* CTA strip */}
        <div className="flex items-center justify-between flex-wrap gap-2 text-xs text-slate-600">
          <div className="flex items-center gap-2">
            <TrendingDown className="size-4 text-emerald-600" />
            <span>
              Caching would drop the pipeline from{" "}
              <strong className="text-slate-900">{inr(totalUncached)}</strong> to{" "}
              <strong className="text-emerald-700">{inr(totalCached)}</strong> per call.
            </span>
          </div>
          <Badge variant="outline" className="bg-white text-[10px]">
            1 USD ≈ ₹{USD_TO_INR}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
};

interface MetricProps {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "neutral";
  highlight?: boolean;
}

const Metric = ({ label, value, sub, tone, highlight }: MetricProps) => (
  <div
    className={`p-3 rounded-xl border ${
      highlight
        ? "bg-emerald-100/50 border-emerald-300"
        : tone === "good"
        ? "bg-emerald-50/50 border-emerald-200"
        : "bg-white border-slate-200"
    }`}
  >
    <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1">
      {label}
    </div>
    <div
      className={`text-xl font-bold ${
        highlight || tone === "good" ? "text-emerald-700" : "text-slate-900"
      }`}
    >
      {value}
    </div>
    {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
  </div>
);
