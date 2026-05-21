import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Zap, Info, TrendingDown, CheckCircle2 } from "lucide-react";
import type { VerificationAggregate, UnifiedCost } from "./types";
import { inr, USD_TO_INR, inrScale } from "@/lib/currency";

/** Azure OpenAI prompt-caching constants.
 *  Source: Microsoft Learn — Prompt Caching with Azure OpenAI Foundry models.
 *  - Cached input is billed at 50% off input rate on Standard deployments.
 *  - Cache kicks in automatically once prefix is ≥ 1024 identical tokens.
 *  - Pipeline now passes per-agent `prompt_cache_key` to pin requests with
 *    identical prefixes → cache hits surface as `cached_tokens` in the usage.
 */
const CACHED_INPUT_DISCOUNT = 0.50;

interface Props {
  unified: UnifiedCost;
  verification: VerificationAggregate;
}

interface AgentRow {
  name: string;
  in_tokens: number;
  cached_tokens: number;
  uncached_tokens: number;
  hit_rate: number;          // 0..1
  cost_actual_usd: number;   // current (after caching discount already applied)
  cost_uncached_usd: number; // what it would have cost without ANY caching
  saved_usd: number;         // uncached - actual
  out_tokens: number;
}

export const CachingEstimator = ({ unified, verification }: Props) => {
  const rows: AgentRow[] = useMemo(() => {
    const r: AgentRow[] = [];
    const inputRate  = unified.rate_card.azure_gpt4o_mini_per_M_input_usd ?? 0.20;
    const outputRate = unified.rate_card.azure_gpt4o_mini_per_M_output_usd ?? 0.60;

    const add = (name: string, cost?: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; cost_usd_total?: number }) => {
      if (!cost) return;
      const in_tok       = cost.prompt_tokens ?? 0;
      const out_tok      = cost.completion_tokens ?? 0;
      const cached       = cost.cached_tokens ?? 0;
      const uncached     = Math.max(0, in_tok - cached);
      // What the same call would have cost if no caching applied
      const cost_uncached = (in_tok / 1_000_000) * inputRate + (out_tok / 1_000_000) * outputRate;
      // Actual cost as reported by the backend (caching discount already baked in)
      const cost_actual   = cost.cost_usd_total ?? cost_uncached;
      r.push({
        name,
        in_tokens: in_tok,
        cached_tokens: cached,
        uncached_tokens: uncached,
        hit_rate: in_tok > 0 ? cached / in_tok : 0,
        cost_actual_usd: cost_actual,
        cost_uncached_usd: cost_uncached,
        saved_usd: Math.max(0, cost_uncached - cost_actual),
        out_tokens: out_tok,
      });
    };

    add("Triage", verification.triage?.cost);
    for (const [k, v] of Object.entries(verification.specialists || {})) {
      if (v?.cost) add(k.replace(/_/g, " "), v.cost);
    }
    add("Decision Agent", verification.decision_agent?.cost);
    if ((verification.reflection?.cost?.cost_usd_total ?? 0) > 0) {
      add("Reflection", verification.reflection?.cost);
    }
    return r;
  }, [unified, verification]);

  const totals = useMemo(() => {
    const t = rows.reduce(
      (acc, r) => ({
        in_tokens:       acc.in_tokens + r.in_tokens,
        cached_tokens:   acc.cached_tokens + r.cached_tokens,
        uncached_tokens: acc.uncached_tokens + r.uncached_tokens,
        cost_actual:     acc.cost_actual + r.cost_actual_usd,
        cost_uncached:   acc.cost_uncached + r.cost_uncached_usd,
        saved:           acc.saved + r.saved_usd,
      }),
      { in_tokens: 0, cached_tokens: 0, uncached_tokens: 0, cost_actual: 0, cost_uncached: 0, saved: 0 },
    );
    return {
      ...t,
      hit_rate: t.in_tokens > 0 ? t.cached_tokens / t.in_tokens : 0,
      pct_saved: t.cost_uncached > 0 ? t.saved / t.cost_uncached : 0,
    };
  }, [rows]);

  // True = caching is actually firing (the backend reported >0 cached tokens).
  // False = we're projecting what would happen if it did fire.
  const cacheLive = totals.cached_tokens > 0;

  // Pipeline-level totals (STT untouched; LLM is what caching affects)
  const llmActual    = totals.cost_actual;
  const llmUncached  = totals.cost_uncached;
  const sttCost      = (unified.stt_usd ?? 0);
  const pipeActual   = sttCost + llmActual;
  const pipeUncached = sttCost + llmUncached;
  const pipeSaved    = Math.max(0, pipeUncached - pipeActual);
  const pipePctSaved = pipeUncached > 0 ? pipeSaved / pipeUncached : 0;

  // Bonus row — if caching is not firing, show estimated future state
  // assuming a steady-state 60% input-token cache hit rate (a realistic value).
  const ESTIMATED_HIT_RATE = 0.60;
  const inputRate  = unified.rate_card.azure_gpt4o_mini_per_M_input_usd ?? 0.20;
  const outputRate = unified.rate_card.azure_gpt4o_mini_per_M_output_usd ?? 0.60;
  let projectedLlmCost = llmUncached;
  if (!cacheLive) {
    let projected = 0;
    for (const r of rows) {
      const cached_input_cost = (r.in_tokens * ESTIMATED_HIT_RATE / 1_000_000) * inputRate * (1 - CACHED_INPUT_DISCOUNT);
      const uncached_input_cost = (r.in_tokens * (1 - ESTIMATED_HIT_RATE) / 1_000_000) * inputRate;
      const out_cost = (r.out_tokens / 1_000_000) * outputRate;
      projected += cached_input_cost + uncached_input_cost + out_cost;
    }
    projectedLlmCost = projected;
  }
  const projectedPipeCost = sttCost + projectedLlmCost;
  const projectedSaved    = Math.max(0, pipeUncached - projectedPipeCost);

  return (
    <Card
      className={`rounded-2xl shadow-sm bg-gradient-to-br from-purple-50/40 to-white ${
        cacheLive ? "border-emerald-200 ring-1 ring-emerald-100" : "border-purple-200"
      }`}
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-3 text-base font-semibold">
          <div
            className={`rounded-lg p-2 border ${
              cacheLive ? "bg-emerald-100 border-emerald-200" : "bg-purple-100 border-purple-200"
            }`}
          >
            <Zap className={`size-4 ${cacheLive ? "text-emerald-700" : "text-purple-700"}`} />
          </div>
          <span>{cacheLive ? "Azure Prompt Caching · Live" : "Azure Prompt Caching · Projected"}</span>
          {cacheLive ? (
            <Badge className="ml-auto bg-emerald-100 text-emerald-800 border-emerald-200 text-[10px]">
              <CheckCircle2 className="size-3 mr-1" />
              {(totals.hit_rate * 100).toFixed(0)}% hit rate
            </Badge>
          ) : (
            <Badge variant="outline" className="ml-auto bg-white text-[10px]">
              estimate · 50% off cached input
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Headline */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Metric
            label="Pipeline cost (uncached)"
            value={inr(pipeUncached)}
            sub="if caching were off"
          />
          <Metric
            label={cacheLive ? "Pipeline cost (actual)" : "Pipeline cost (projected)"}
            value={inr(cacheLive ? pipeActual : projectedPipeCost)}
            sub={
              cacheLive
                ? `${(pipePctSaved * 100).toFixed(0)}% lower (live)`
                : `at ${(ESTIMATED_HIT_RATE * 100).toFixed(0)}% steady-state hit rate`
            }
            tone="good"
          />
          <Metric
            label={cacheLive ? "Savings this call" : "Projected savings"}
            value={inr(cacheLive ? pipeSaved : projectedSaved)}
            sub={
              cacheLive
                ? `${totals.cached_tokens.toLocaleString()} of ${totals.in_tokens.toLocaleString()} input tokens cached`
                : "before caching warm-up completes"
            }
            tone="good"
            highlight
          />
        </div>

        {/* Per-agent table */}
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="grid grid-cols-12 gap-2 text-[10px] font-medium uppercase tracking-wide text-slate-500 bg-slate-50 px-3 py-2 border-b border-slate-200">
            <div className="col-span-3">Agent</div>
            <div className="col-span-2 text-right">In tok</div>
            <div className="col-span-2 text-right">{cacheLive ? "Cached" : "Cacheable"}</div>
            <div className="col-span-2 text-right">{cacheLive ? "Hit %" : "Est. %"}</div>
            <div className="col-span-1 text-right">No-cache</div>
            <div className="col-span-1 text-right">Actual</div>
            <div className="col-span-1 text-right">Saved</div>
          </div>
          {rows.map((r, i) => (
            <div
              key={i}
              className="grid grid-cols-12 gap-2 px-3 py-2 text-xs border-b border-slate-100 last:border-0 hover:bg-slate-50/50 transition-colors"
            >
              <div className="col-span-3 text-slate-700 capitalize">{r.name}</div>
              <div className="col-span-2 text-right text-slate-500 font-mono">{r.in_tokens.toLocaleString()}</div>
              <div className="col-span-2 text-right text-emerald-700 font-mono">{r.cached_tokens.toLocaleString()}</div>
              <div className="col-span-2 text-right text-emerald-700 font-mono font-medium">
                {(r.hit_rate * 100).toFixed(0)}%
              </div>
              <div className="col-span-1 text-right text-slate-500 font-mono">{inr(r.cost_uncached_usd)}</div>
              <div className="col-span-1 text-right text-slate-900 font-mono">{inr(r.cost_actual_usd)}</div>
              <div className="col-span-1 text-right text-emerald-700 font-mono font-medium">
                {r.saved_usd > 0 ? inr(r.saved_usd) : "—"}
              </div>
            </div>
          ))}
        </div>

        {/* At-scale projection (uses the higher of actual or projected savings) */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          {[
            ["per call",       cacheLive ? pipeSaved : projectedSaved],
            ["1,000 calls",   (cacheLive ? pipeSaved : projectedSaved) * 1_000],
            ["10,000 calls",  (cacheLive ? pipeSaved : projectedSaved) * 10_000],
            ["1 Lakh calls",  (cacheLive ? pipeSaved : projectedSaved) * 1_00_000],
          ].map(([label, val]) => (
            <div key={label as string} className="p-2 rounded-lg bg-emerald-50/40 border border-emerald-100">
              <div className="text-[10px] text-slate-500">save / {label}</div>
              <div className="text-sm font-bold text-emerald-700 font-mono mt-0.5">
                {inrScale(val as number)}
              </div>
            </div>
          ))}
        </div>

        {/* Methodology + status footer */}
        <div
          className={`rounded-lg border p-3 flex items-start gap-2 ${
            cacheLive ? "bg-emerald-50/40 border-emerald-200" : "bg-amber-50/40 border-amber-200"
          }`}
        >
          <Info className={`size-3.5 mt-0.5 flex-shrink-0 ${cacheLive ? "text-emerald-700" : "text-amber-700"}`} />
          <div className={`text-[11px] leading-relaxed ${cacheLive ? "text-emerald-900" : "text-amber-900"}`}>
            {cacheLive ? (
              <>
                <strong>Caching is firing.</strong> The numbers above are <em>actual</em> —
                Azure's prompt cache served {totals.cached_tokens.toLocaleString()} of {totals.in_tokens.toLocaleString()}{" "}
                input tokens for this call, billed at the 50% cached-input rate. Hit rate climbs with batch warm-up
                (each agent's system prompt becomes the cached prefix). Output tokens are never cached. STT cost is unaffected.
              </>
            ) : (
              <>
                <strong>Caching not detected on this call.</strong> Numbers above are <em>projected</em> at a
                conservative {(ESTIMATED_HIT_RATE * 100).toFixed(0)}% input-token hit rate. The pipeline already
                passes per-agent <code>prompt_cache_key</code> — the cache becomes hot once the same agent runs
                twice within a 5-10 min window. Re-running this batch should show real cache hits.
              </>
            )}
          </div>
        </div>

        {/* CTA strip */}
        <div className="flex items-center justify-between flex-wrap gap-2 text-xs text-slate-600">
          <div className="flex items-center gap-2">
            <TrendingDown className="size-4 text-emerald-600" />
            <span>
              {cacheLive ? (
                <>
                  Caching dropped the pipeline from{" "}
                  <strong className="text-slate-900">{inr(pipeUncached)}</strong> to{" "}
                  <strong className="text-emerald-700">{inr(pipeActual)}</strong> on this call.
                </>
              ) : (
                <>
                  Caching would drop the pipeline from{" "}
                  <strong className="text-slate-900">{inr(pipeUncached)}</strong> to{" "}
                  <strong className="text-emerald-700">{inr(projectedPipeCost)}</strong> per call.
                </>
              )}
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
