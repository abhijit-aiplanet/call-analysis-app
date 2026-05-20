import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Hourglass, CheckCircle2, XCircle, Loader2, FileAudio,
} from "lucide-react";
import type { BatchJob, FileStatus } from "./types";

const STATUS_TONE: Record<FileStatus, string> = {
  queued:            "bg-slate-100 text-slate-500 border-slate-200",
  running_stt:       "bg-blue-100 text-blue-700 border-blue-200",
  running_sentiment: "bg-purple-100 text-purple-700 border-purple-200",
  ok:                "bg-emerald-100 text-emerald-700 border-emerald-200",
  error:             "bg-red-100 text-red-700 border-red-200",
};

const STATUS_LABEL: Record<FileStatus, string> = {
  queued:            "Queued",
  running_stt:       "Transcribing",
  running_sentiment: "Analyzing",
  ok:                "Done",
  error:             "Failed",
};

interface BatchProgressProps {
  job: BatchJob;
}

export const BatchProgress = ({ job }: BatchProgressProps) => {
  const isDone = job.status === "completed" || job.status === "completed_with_errors" || job.status === "failed";

  return (
    <Card className="rounded-2xl border-slate-200 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
            {isDone ? (
              <CheckCircle2 className="size-5 text-emerald-600" />
            ) : (
              <Loader2 className="size-5 text-blue-600 animate-spin" />
            )}
            <span>{isDone ? "Batch Complete" : "Processing Batch"}</span>
          </CardTitle>
          <Badge variant="outline" className="text-[10px] font-mono">
            job: {job.job_id.slice(0, 8)}…
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Aggregate progress bar */}
        <div>
          <div className="flex items-center justify-between mb-1.5 text-sm">
            <span className="text-slate-700 font-medium">
              {job.completed_count + job.failed_count} / {job.file_count} processed
              {job.failed_count > 0 && <span className="text-red-600 ml-2">({job.failed_count} failed)</span>}
            </span>
            <span className="text-slate-500 font-mono">{job.progress_pct.toFixed(0)}%</span>
          </div>
          <Progress value={job.progress_pct} className="h-2" />
        </div>

        {/* Quick chips */}
        <div className="flex flex-wrap gap-1.5">
          {job.completed_count > 0 && (
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 font-normal">
              <CheckCircle2 className="size-3 mr-1" /> {job.completed_count} done
            </Badge>
          )}
          {job.running_count > 0 && (
            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 font-normal">
              <Loader2 className="size-3 mr-1 animate-spin" /> {job.running_count} running
            </Badge>
          )}
          {job.queued_count > 0 && (
            <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200 font-normal">
              <Hourglass className="size-3 mr-1" /> {job.queued_count} queued
            </Badge>
          )}
          {job.failed_count > 0 && (
            <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 font-normal">
              <XCircle className="size-3 mr-1" /> {job.failed_count} failed
            </Badge>
          )}
        </div>

        {/* Per-file status list */}
        <div className="rounded-lg border border-slate-100 bg-slate-50/40 divide-y divide-slate-100 max-h-64 overflow-y-auto">
          {job.files.map((f, i) => {
            const tone = STATUS_TONE[f.status];
            return (
              <div key={i} className="flex items-center gap-3 px-3 py-2 hover:bg-white transition-colors">
                <FileAudio className="size-4 text-slate-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-800 truncate">{f.filename}</div>
                  {f.error && <div className="text-[11px] text-red-600 mt-0.5 truncate" title={f.error}>{f.error}</div>}
                  {f.result && (
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {f.result.audio_meta.language_code} · {f.result.audio_meta.audio_duration_s.toFixed(0)}s · ${f.result.unified_cost.total_usd.toFixed(4)}
                    </div>
                  )}
                </div>
                <Badge variant="outline" className={`${tone} font-normal text-[10px] flex-shrink-0`}>
                  {f.status === "running_stt" || f.status === "running_sentiment" ? (
                    <Loader2 className="size-3 mr-1 animate-spin" />
                  ) : f.status === "ok" ? (
                    <CheckCircle2 className="size-3 mr-1" />
                  ) : f.status === "error" ? (
                    <XCircle className="size-3 mr-1" />
                  ) : (
                    <Hourglass className="size-3 mr-1" />
                  )}
                  {STATUS_LABEL[f.status]}
                </Badge>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};
