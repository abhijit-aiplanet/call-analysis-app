import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Upload, X, FileAudio, Play, AlertTriangle, Folder,
} from "lucide-react";
import { KeytermsInput } from "./KeytermsInput";

interface BatchUploaderProps {
  onSubmit: (files: File[], keyterms: string[]) => void;
  isSubmitting?: boolean;
  error?: string | null;
}

export const BatchUploader = ({ onSubmit, isSubmitting, error }: BatchUploaderProps) => {
  const [files, setFiles] = useState<File[]>([]);
  const [keyterms, setKeyterms] = useState<string[]>([
    "Bajaj Auto Credit", "EMI", "OTP", "Aadhaar", "PAN",
  ]);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (newFiles: File[]) => {
    const audioFiles = newFiles.filter((f) => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg|webm)$/i.test(f.name));
    if (audioFiles.length === 0) return;
    setFiles((prev) => {
      const merged = [...prev];
      for (const f of audioFiles) {
        if (!merged.find((m) => m.name === f.name && m.size === f.size)) merged.push(f);
        if (merged.length >= 50) break;
      }
      return merged.slice(0, 50);
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files) addFiles(Array.from(e.dataTransfer.files));
  };

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));
  const clearAll = () => setFiles([]);

  const totalMb = files.reduce((s, f) => s + f.size, 0) / 1024 / 1024;

  return (
    <Card className="rounded-2xl border-slate-200 shadow-sm">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
          <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-2">
            <Upload className="size-4 text-emerald-700" />
          </div>
          <span>Upload Call Recordings</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Drop zone */}
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          className={`relative flex items-center justify-center w-full min-h-36 border-2 border-dashed rounded-2xl cursor-pointer transition-all duration-200 ${
            isDragOver
              ? "border-emerald-500 bg-emerald-50/50"
              : "border-slate-300 hover:border-emerald-400 hover:bg-slate-50/50"
          }`}
        >
          <div className="text-center p-6">
            <Folder className={`size-10 mx-auto mb-2 ${isDragOver ? "text-emerald-500" : "text-slate-400"}`} />
            <p className="text-sm text-slate-700 font-medium">
              {isDragOver ? "Drop your files here" : "Click to choose files or drag & drop"}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              MP3 / WAV / M4A / AAC / FLAC / OGG · Up to 50 files per batch
            </p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.webm,audio/*"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* File list */}
        {files.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-700">
                  {files.length} file{files.length !== 1 ? "s" : ""} ready
                </span>
                <Badge variant="outline" className="text-[10px] font-normal">
                  {totalMb.toFixed(2)} MB total
                </Badge>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearAll}
                disabled={isSubmitting}
                className="h-7 text-xs text-slate-500 hover:text-red-600"
              >
                Clear all
              </Button>
            </div>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/40 divide-y divide-slate-100">
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} className="flex items-center gap-3 px-3 py-2 hover:bg-white transition-colors">
                  <FileAudio className="size-4 text-slate-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-800 truncate">{f.name}</div>
                    <div className="text-[11px] text-slate-500">{(f.size / 1024 / 1024).toFixed(2)} MB</div>
                  </div>
                  {!isSubmitting && (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                      className="text-slate-400 hover:text-red-500 transition-colors flex-shrink-0"
                      aria-label="Remove file"
                    >
                      <X className="size-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Keyterms */}
        <KeytermsInput keyterms={keyterms} onChange={setKeyterms} disabled={isSubmitting} />

        {/* Submit */}
        <Button
          onClick={() => onSubmit(files, keyterms)}
          disabled={files.length === 0 || isSubmitting}
          className="w-full bg-emerald-600 hover:bg-emerald-700 text-white h-11"
        >
          {isSubmitting ? (
            <div className="flex items-center gap-2">
              <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
              <span>Submitting batch…</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Play className="size-4" />
              <span>
                Analyze {files.length > 0 ? files.length : ""} {files.length === 1 ? "Call" : "Calls"}
              </span>
            </div>
          )}
        </Button>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
            <AlertTriangle className="size-4 text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
