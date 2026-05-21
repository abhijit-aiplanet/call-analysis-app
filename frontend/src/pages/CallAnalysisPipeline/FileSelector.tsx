import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  FileAudio, CheckCircle2, XCircle, ChevronRight, ChevronLeft,
} from "lucide-react";
import type { BatchFileEntry } from "./types";
import { inr } from "@/lib/currency";

interface FileSelectorProps {
  files: BatchFileEntry[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
}

export const FileSelector = ({ files, selectedIdx, onSelect }: FileSelectorProps) => {
  const goPrev = () => {
    for (let i = selectedIdx - 1; i >= 0; i--) {
      if (files[i].status === "ok") return onSelect(i);
    }
  };
  const goNext = () => {
    for (let i = selectedIdx + 1; i < files.length; i++) {
      if (files[i].status === "ok") return onSelect(i);
    }
  };

  return (
    <Card className="rounded-2xl border-slate-200 shadow-sm">
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={goPrev}
            disabled={selectedIdx <= 0}
            className="h-7 px-2"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-xs font-medium text-slate-500 flex-1">
            Viewing call {selectedIdx + 1} of {files.length}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={goNext}
            disabled={selectedIdx >= files.length - 1}
            className="h-7 px-2"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
          {files.map((f, i) => {
            const isSelected = i === selectedIdx;
            const isOK = f.status === "ok";
            const isErr = f.status === "error";
            const isPending = !isOK && !isErr;
            // Pull RCU verdict surface for inline preview on each card
            const v = isOK ? f.result?.rcu_verdict : undefined;
            const tag = v?.headline_chip || v?.disposition || undefined;
            const verdict = v?.verdict;
            const callerType = v?.caller_type;
            const cost = f.result?.unified_cost.total_usd;
            const lang = f.result?.audio_meta.language_code;
            return (
              <button
                key={i}
                onClick={() => isOK && onSelect(i)}
                disabled={!isOK}
                className={`text-left rounded-lg border transition-all p-2.5 ${
                  isSelected
                    ? "bg-emerald-50 border-emerald-400 ring-1 ring-emerald-300"
                    : isOK
                    ? "bg-white border-slate-200 hover:border-emerald-300 hover:bg-emerald-50/30 cursor-pointer"
                    : isErr
                    ? "bg-red-50/50 border-red-200 opacity-70"
                    : "bg-slate-50 border-slate-200 opacity-60"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <FileAudio className="size-3.5 text-slate-400 flex-shrink-0" />
                  <span className="text-xs font-medium text-slate-700 truncate flex-1">
                    #{i + 1} · {f.filename.replace(/_BAJAJ-all\.mp3$/, "")}
                  </span>
                  {isOK && <CheckCircle2 className="size-3.5 text-emerald-500 flex-shrink-0" />}
                  {isErr && <XCircle className="size-3.5 text-red-500 flex-shrink-0" />}
                </div>
                {tag && (
                  <div className="text-[11px] text-slate-600 leading-snug line-clamp-2 mb-1">{tag}</div>
                )}
                <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                  {verdict && (
                    <Badge variant="outline" className={`py-0 font-medium ${
                      verdict === "Critical" ? "bg-red-50 text-red-700 border-red-200"
                      : verdict === "Negative" ? "bg-amber-50 text-amber-700 border-amber-200"
                      : verdict === "Positive" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-slate-50 text-slate-600 border-slate-200"
                    }`}>
                      {verdict}
                    </Badge>
                  )}
                  {callerType && callerType !== "Unknown" && (
                    <Badge variant="outline" className="bg-white py-0 font-normal text-slate-600">
                      {callerType}
                    </Badge>
                  )}
                  {lang && (
                    <Badge variant="outline" className="bg-white/70 font-mono py-0 font-normal">
                      {lang}
                    </Badge>
                  )}
                  {cost != null && (
                    <span className="ml-auto font-mono text-slate-500">{inr(cost)}</span>
                  )}
                </div>
                {isPending && (
                  <div className="text-[10px] text-slate-500 italic">{f.status.replace("_", " ")}…</div>
                )}
                {isErr && f.error && (
                  <div className="text-[10px] text-red-600 truncate" title={f.error}>{f.error}</div>
                )}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};
