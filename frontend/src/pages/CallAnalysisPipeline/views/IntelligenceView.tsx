import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  User, Tag as TagIcon, TrendingUp, ShoppingBag,
  ThumbsUp, ThumbsDown, FileSearch,
} from "lucide-react";

interface Props {
  output: Record<string, unknown>;
}

const intentColor = (level?: string) => {
  switch ((level || "").toLowerCase()) {
    case "high":     return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "medium":   return "bg-amber-100 text-amber-800 border-amber-200";
    case "low":      return "bg-slate-100 text-slate-700 border-slate-200";
    default:         return "bg-slate-50 text-slate-500 border-slate-200";
  }
};

const stageColor = (stage?: string) => {
  if (!stage) return "bg-slate-50 text-slate-500";
  if (stage.includes("complaint"))                     return "bg-red-50 text-red-700 border-red-200";
  if (["disbursed", "approved", "sanction"].some(s => stage.includes(s))) return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (stage.includes("cold"))                          return "bg-blue-50 text-blue-700 border-blue-200";
  return "bg-amber-50 text-amber-700 border-amber-200";
};

export const IntelligenceView = ({ output }: Props) => {
  const agentName    = output.agent_name as string | undefined;
  const callCategory = output.call_category as string | undefined;
  const extracted    = (output.extracted_info as Record<string, string>) || {};
  const intent       = (output.purchase_intent as Record<string, unknown>) || {};
  const buyingSignals = (output.buying_signals as string[]) || [];
  const objections   = (output.objections_raised as string[]) || [];
  const domainTerms  = (output.domain_terms_used as string[]) || [];

  return (
    <div className="space-y-4">
      {/* Agent + category header */}
      <Card className="rounded-2xl border-slate-200 bg-gradient-to-br from-slate-50 to-white">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2.5">
              <div className="bg-emerald-100 rounded-full p-2">
                <User className="size-4 text-emerald-700" />
              </div>
              <div>
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">Agent</div>
                <div className="text-sm font-semibold text-slate-900">{agentName || "Unidentified"}</div>
              </div>
            </div>
            {callCategory && (
              <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 font-medium">
                {callCategory.replace(/_/g, " ")}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Extracted fields grid */}
      <Card className="rounded-2xl border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
            <FileSearch className="size-4 text-slate-600" />
            <span>Extracted Details</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {Object.entries(extracted).map(([k, v]) => (
              <div key={k} className="px-3 py-2 rounded-lg bg-slate-50/70 border border-slate-100">
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-0.5">
                  {k.replace(/_/g, " ")}
                </div>
                <div className="text-sm text-slate-800 break-words">{v || "—"}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Purchase intent */}
      {intent && Object.keys(intent).length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
              <ShoppingBag className="size-4 text-slate-600" />
              <span>Purchase Intent</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge className={`${intentColor(intent.level as string)} font-medium px-3 py-1`}>
                <TrendingUp className="size-3 mr-1.5" />
                {String(intent.level || "—")}
              </Badge>
              {intent.deal_stage && (
                <Badge variant="outline" className={`${stageColor(intent.deal_stage as string)} font-normal`}>
                  Stage: {String(intent.deal_stage).replace(/_/g, " ")}
                </Badge>
              )}
            </div>
            {intent.reasoning && (
              <p className="text-sm text-slate-700 leading-relaxed bg-slate-50/70 rounded-lg p-3 border border-slate-100">
                {String(intent.reasoning)}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Buying signals + objections side-by-side */}
      {(buyingSignals.length > 0 || objections.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {buyingSignals.length > 0 && (
            <Card className="rounded-2xl border-emerald-200/60 bg-emerald-50/30">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-emerald-800">
                  <ThumbsUp className="size-4" />
                  <span>Buying Signals</span>
                  <Badge variant="outline" className="ml-auto bg-white text-emerald-700 border-emerald-200 font-normal text-[10px]">
                    {buyingSignals.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {buyingSignals.map((s, i) => (
                    <li key={i} className="text-sm text-slate-700 flex gap-2 items-start">
                      <span className="size-1.5 rounded-full bg-emerald-500 mt-2 flex-shrink-0" />
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {objections.length > 0 && (
            <Card className="rounded-2xl border-amber-200/60 bg-amber-50/30">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-amber-800">
                  <ThumbsDown className="size-4" />
                  <span>Objections Raised</span>
                  <Badge variant="outline" className="ml-auto bg-white text-amber-700 border-amber-200 font-normal text-[10px]">
                    {objections.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {objections.map((s, i) => (
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
      )}

      {/* Domain terms chips */}
      {domainTerms.length > 0 && (
        <Card className="rounded-2xl border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-slate-700">
              <TagIcon className="size-4" />
              <span>Domain Terms Mentioned</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {domainTerms.map((t, i) => (
                <Badge key={i} variant="outline" className="bg-slate-50 text-slate-600 border-slate-200 font-mono text-[11px] font-normal">
                  {t}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
