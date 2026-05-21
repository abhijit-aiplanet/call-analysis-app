import { useEffect, useRef, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MessageSquare, Tag, Play, Pause, Rewind, FastForward,
  Subtitles, Volume2, VolumeX, AlertCircle, Target,
} from "lucide-react";
import type { AnalysisRecord } from "./types";

interface Props {
  result: AnalysisRecord;
  audioUrl: string | null;
}

type AudioStatus = "idle" | "loading" | "ready" | "error";

/** Subtitle-style transcript with a STICKY audio player at the top.
 *  Auto-scroll moves only the transcript list (not the page) so the
 *  player remains reachable at all times. */
export const AudioTranscript = ({ result, audioUrl }: Props) => {
  const utterances = result.stage_1_stt.utterances;
  const behaviorOut = result.stage_2_verification.specialists?.conversation_behavior?.output as
    | Record<string, unknown>
    | undefined;
  const perUtt =
    (behaviorOut?.per_utterance as Array<{ idx?: number; speaker_role?: string; behavior_tag?: string }>) || [];

  const audioRef = useRef<HTMLAudioElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const [activeIdx, setActiveIdx] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [autoScroll, setAutoScroll] = useState(true);
  const [audioStatus, setAudioStatus] = useState<AudioStatus>(audioUrl ? "loading" : "idle");
  const [audioError, setAudioError] = useState<string | null>(null);

  // Wire audio event listeners — covers playback state, metadata, and errors.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      setCurrentTime(audio.currentTime);
      const t = audio.currentTime;
      let idx = -1;
      for (let i = 0; i < utterances.length; i++) {
        const start = utterances[i].start_s ?? 0;
        if (start <= t + 0.01) idx = i;
        else break;
      }
      setActiveIdx((cur) => (cur !== idx ? idx : cur));
    };
    const onMeta = () => {
      setDuration(audio.duration || 0);
      setAudioStatus("ready");
    };
    const onCanPlay = () => setAudioStatus("ready");
    const onErr = () => {
      setAudioStatus("error");
      const err = audio.error;
      const code = err?.code;
      const msg =
        code === 1 ? "Playback aborted" :
        code === 2 ? "Network error fetching audio" :
        code === 3 ? "Audio decoding failed — file may be corrupt or unsupported format" :
        code === 4 ? "Audio source not supported by the browser" :
        "Audio failed to load";
      setAudioError(msg);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("error", onErr);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("error", onErr);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [utterances]);

  // When audioUrl changes (user switches file), reset state + force reload
  useEffect(() => {
    if (!audioUrl) {
      setAudioStatus("idle");
      setDuration(0);
      setCurrentTime(0);
      setActiveIdx(-1);
      return;
    }
    setAudioStatus("loading");
    setAudioError(null);
    // Force the element to re-evaluate the src (Blob URL or otherwise)
    requestAnimationFrame(() => audioRef.current?.load());
  }, [audioUrl]);

  // Auto-scroll active utterance into view — manually, only within the list
  // container so the PAGE never scrolls (the previous scrollIntoView() called
  // up the chain and dragged the whole window with it).
  useEffect(() => {
    if (!autoScroll || activeIdx < 0 || !isPlaying) return;
    const container = listRef.current;
    const item = itemRefs.current[activeIdx];
    if (!container || !item) return;
    const cRect = container.getBoundingClientRect();
    const iRect = item.getBoundingClientRect();
    const itemTopInContainer = iRect.top - cRect.top + container.scrollTop;
    const target = itemTopInContainer - (cRect.height / 2) + (iRect.height / 2);
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [activeIdx, isPlaying, autoScroll]);

  // Apply playback rate
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(seconds, duration || seconds));
    if (!isPlaying) audio.play().catch(() => {});
  }, [duration, isPlaying]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch((err) => {
        setAudioStatus("error");
        setAudioError(`Browser refused to play audio: ${err?.message || err}`);
      });
    } else {
      audio.pause();
    }
  };

  const skip = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.currentTime + delta, duration || audio.currentTime + delta));
  };

  // Jump back to the active utterance — useful when auto-scroll is off
  const scrollToActive = () => {
    const container = listRef.current;
    const item = itemRefs.current[activeIdx];
    if (!container || !item) return;
    const cRect = container.getBoundingClientRect();
    const iRect = item.getBoundingClientRect();
    const itemTopInContainer = iRect.top - cRect.top + container.scrollTop;
    const target = itemTopInContainer - (cRect.height / 2) + (iRect.height / 2);
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  };

  const borderColorFor = (idx: number): string => {
    const tag = perUtt[idx]?.behavior_tag || "neutral";
    if (["prompted_by_third_party", "contradictory", "evasive", "irate", "defensive"].includes(tag))
      return "border-l-red-500";
    if (["fumbling", "hesitant", "rushed_through", "rehearsed"].includes(tag))
      return "border-l-amber-400";
    if (["cooperative"].includes(tag)) return "border-l-emerald-400";
    return "border-l-slate-200";
  };

  const roleLabel = (idx: number): string | null => {
    const role = perUtt[idx]?.speaker_role;
    if (role === "agent") return "AGENT";
    if (role === "subject") return "SUBJECT";
    if (role === "third_party") return "3RD-PARTY";
    return null;
  };

  const fmtTime = (s: number) => {
    if (!isFinite(s)) return "0:00";
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${mm}:${String(ss).padStart(2, "0")}`;
  };

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    // overflow-visible (not overflow-hidden) is REQUIRED for `sticky` children to work.
    <Card className="rounded-2xl border-slate-200 overflow-visible">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
          <MessageSquare className="size-4 text-purple-600" />
          <span>Diarized Transcript</span>
          <Badge variant="outline" className="ml-auto text-[10px] font-normal">
            {utterances.length} utterances · {result.audio_meta.num_speakers} speakers · {result.audio_meta.language_code}
          </Badge>
        </CardTitle>
        {result.audio_meta.keyterms_applied.length > 0 && (
          <div className="flex items-start gap-2 mt-2 text-xs text-slate-500">
            <Tag className="size-3 mt-0.5 flex-shrink-0" />
            <span>
              Biased toward: {result.audio_meta.keyterms_applied.slice(0, 8).join(", ")}
              {result.audio_meta.keyterms_applied.length > 8 && ` (+${result.audio_meta.keyterms_applied.length - 8} more)`}
            </span>
          </div>
        )}
      </CardHeader>

      {/* ── STICKY AUDIO PLAYER ─────────────────────────────────────────
          top-[68px] sits just below the Layout's sticky brand header (~64px tall).
          z-20 keeps it under the brand header (z-40) but over everything else. */}
      {audioUrl ? (
        <div className="sticky top-[68px] z-20 -mt-px">
          <div className="bg-gradient-to-r from-emerald-50/60 via-white to-slate-50/60 backdrop-blur-sm border-y border-slate-200 px-4 py-3.5 space-y-2.5 shadow-sm">
            <audio
              ref={audioRef}
              src={audioUrl}
              preload="auto"
              className="hidden"
              muted={muted}
            />

            {audioStatus === "error" && (
              <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5">
                <AlertCircle className="size-3.5 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">Audio playback unavailable</div>
                  <div className="text-red-600/80">{audioError || "Unknown error"}</div>
                  <div className="text-[10px] text-red-500/80 mt-0.5">
                    Tip: the audio file lives only in your current browser session — if you reloaded the page since uploading, the Blob URL is gone. Re-upload to play.
                  </div>
                </div>
              </div>
            )}

            {/* Progress bar — clickable to seek */}
            <div
              className={`group relative h-2.5 rounded-full cursor-pointer transition-colors ${
                audioStatus === "error" ? "bg-red-100" : "bg-slate-200"
              }`}
              onClick={(e) => {
                if (!duration || audioStatus === "error") return;
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = (e.clientX - rect.left) / rect.width;
                seek(ratio * duration);
              }}
            >
              <div
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-[width] duration-200 ease-out shadow-sm"
                style={{ width: `${progressPct}%` }}
              />
              <div
                className="absolute -top-1 size-4 -ml-2 rounded-full bg-emerald-600 ring-2 ring-white shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ left: `${progressPct}%` }}
              />
            </div>

            {/* Controls row */}
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="ghost" onClick={() => skip(-5)} className="h-8 w-8 p-0" aria-label="Back 5s">
                <Rewind className="size-4" />
              </Button>
              <Button
                size="sm"
                onClick={togglePlay}
                disabled={audioStatus === "error"}
                className="h-9 w-9 p-0 bg-emerald-600 hover:bg-emerald-700 text-white rounded-full disabled:opacity-50"
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? <Pause className="size-4" /> : <Play className="size-4 ml-0.5" />}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => skip(5)} className="h-8 w-8 p-0" aria-label="Forward 5s">
                <FastForward className="size-4" />
              </Button>

              <span className="text-xs font-mono text-slate-600 tabular-nums ml-1">
                {fmtTime(currentTime)} <span className="text-slate-400">/ {fmtTime(duration)}</span>
              </span>

              {audioStatus === "loading" && (
                <Badge variant="outline" className="bg-white text-[10px] text-slate-500 font-normal">
                  loading…
                </Badge>
              )}
              {audioStatus === "ready" && duration > 0 && (
                <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px] font-normal">
                  ready
                </Badge>
              )}

              <div className="ml-auto flex items-center gap-1.5">
                {/* Jump-to-active button */}
                {activeIdx >= 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={scrollToActive}
                    className="h-7 px-2 text-[10px]"
                    title="Scroll transcript to the currently-playing line"
                  >
                    <Target className="size-3 mr-1" />
                    Jump to active
                  </Button>
                )}

                {/* Playback speed */}
                <div className="flex items-center gap-0.5 bg-white rounded-md border border-slate-200 p-0.5">
                  {[0.75, 1, 1.25, 1.5, 2].map((r) => (
                    <button
                      key={r}
                      onClick={() => setPlaybackRate(r)}
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                        playbackRate === r
                          ? "bg-slate-800 text-white"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      {r}x
                    </button>
                  ))}
                </div>

                {/* Auto-scroll toggle */}
                <Button
                  size="sm"
                  variant={autoScroll ? "default" : "outline"}
                  onClick={() => setAutoScroll((v) => !v)}
                  className={`h-7 px-2 text-[10px] ${
                    autoScroll ? "bg-purple-600 hover:bg-purple-700 text-white" : ""
                  }`}
                  title="Auto-scroll transcript while playing"
                >
                  <Subtitles className="size-3 mr-1" />
                  {autoScroll ? "Auto" : "Manual"}
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMuted((v) => !v)}
                  className="h-8 w-8 p-0"
                  aria-label={muted ? "Unmute" : "Mute"}
                >
                  {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-slate-50 border-y border-slate-200 px-4 py-2 text-xs text-slate-500 flex items-center gap-2">
          <AlertCircle className="size-3.5 text-slate-400" />
          Audio playback not available — file isn't in the current browser session.
          You can still click any utterance to follow the transcript visually.
        </div>
      )}

      <CardContent>
        <div ref={listRef} className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
          {utterances.map((u, i) => {
            const role = roleLabel(i);
            const tag = perUtt[i]?.behavior_tag;
            const t = u.start_s ?? 0;
            const isActive = i === activeIdx;
            return (
              <div
                key={i}
                ref={(el) => { itemRefs.current[i] = el; }}
                onClick={() => seek(t)}
                className={`flex gap-3 pl-3 py-2 border-l-[3px] rounded-r-lg transition-all duration-200 cursor-pointer ${
                  isActive
                    ? "bg-gradient-to-r from-emerald-100/80 to-emerald-50/40 border-l-emerald-500 ring-1 ring-emerald-300 shadow-md scale-[1.005]"
                    : `${borderColorFor(i)} bg-slate-50/40 hover:bg-slate-100/60 hover:translate-x-0.5`
                }`}
              >
                <div className="flex-shrink-0 text-[11px] font-mono pt-0.5 w-12 tabular-nums">
                  <span className={isActive ? "text-emerald-700 font-semibold" : "text-slate-400"}>
                    {fmtTime(t)}
                  </span>
                </div>
                <div className="flex-shrink-0 w-24">
                  <Badge
                    variant="outline"
                    className={`text-[10px] font-mono py-0 ${
                      role === "AGENT"
                        ? "bg-blue-50 text-blue-700 border-blue-200"
                        : role === "SUBJECT"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : role === "3RD-PARTY"
                        ? "bg-red-50 text-red-700 border-red-200"
                        : "bg-slate-50"
                    }`}
                  >
                    {role || u.speaker || "?"}
                  </Badge>
                </div>
                <div className="flex-1 min-w-0">
                  <div
                    className={`text-sm leading-relaxed ${
                      isActive ? "text-slate-900 font-medium" : "text-slate-800"
                    }`}
                  >
                    {u.text}
                  </div>
                  {tag && tag !== "neutral" && (
                    <div className="mt-1">
                      <Badge variant="outline" className="text-[9px] py-0 bg-white text-slate-600">
                        {tag.replace(/_/g, " ")}
                      </Badge>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};
