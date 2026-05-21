import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Plus, X, Tag, Sparkles } from "lucide-react";
import axios from "axios";
import { API_BASE_URL } from "./api";

const DEFAULT_BAJAJ_KEYTERMS = [
  "Bajaj Auto Credit",
  "EMI",
  "OTP",
  "Aadhaar",
  "PAN",
  "ROI",
  "NOC",
  "sanction letter",
  "disbursement",
  "foreclosure",
  "Pulsar",
  "Avenger",
];

type SttVendor = "soniox" | "elevenlabs" | "unknown";

interface KeytermsInputProps {
  keyterms: string[];
  onChange: (terms: string[]) => void;
  disabled?: boolean;
}

export const KeytermsInput = ({ keyterms, onChange, disabled }: KeytermsInputProps) => {
  const [draft, setDraft] = useState("");
  const [sttVendor, setSttVendor] = useState<SttVendor>("unknown");

  // Detect the active STT provider so we can correctly label the keyterms
  // behaviour (Soniox: free context.terms boost · ElevenLabs: $0.05/hr surcharge).
  useEffect(() => {
    let cancelled = false;
    axios
      .get<{ vendors?: { stt_provider_env?: string } }>(`${API_BASE_URL}/health`, { timeout: 4000 })
      .then((r) => {
        if (cancelled) return;
        const env = (r.data?.vendors?.stt_provider_env || "").toLowerCase();
        if (env === "soniox") setSttVendor("soniox");
        else if (env === "elevenlabs") setSttVendor("elevenlabs");
        else setSttVendor("unknown");
      })
      .catch(() => {
        if (!cancelled) setSttVendor("unknown");
      });
    return () => { cancelled = true; };
  }, []);

  const add = (term: string) => {
    const clean = term.trim();
    if (!clean) return;
    if (keyterms.includes(clean)) return;
    if (clean.length > 50) return;
    if (clean.split(/\s+/).length > 5) return;
    onChange([...keyterms, clean]);
  };

  const remove = (term: string) => onChange(keyterms.filter((t) => t !== term));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    add(draft);
    setDraft("");
  };

  const loadDefaults = () => {
    const merged = Array.from(new Set([...keyterms, ...DEFAULT_BAJAJ_KEYTERMS]));
    onChange(merged.slice(0, 1000));
  };

  // Provider-aware label + footer text
  const isSoniox = sttVendor === "soniox";
  const labelHelper = isSoniox
    ? "context-boost · free with Soniox · improves recognition accuracy"
    : sttVendor === "elevenlabs"
    ? "$0.05/hr surcharge on ElevenLabs"
    : "biases the STT toward Bajaj-specific vocabulary";

  const emptyHelper = isSoniox
    ? "No keyterms — STT will run with default RCU context only. Adding keyterms is FREE on Soniox and improves recognition of domain-specific names, brands and Indian-language phrases. Recommended: Bajaj Auto Credit, EMI, OTP, Aadhaar, vehicle models."
    : "No keyterms — STT will run on its base model. Adding keyterms costs +$0.05/hr of audio on ElevenLabs but dramatically improves accuracy on domain terms (we recommend at least “Bajaj Auto Credit”, “EMI”, “OTP”, “Aadhaar”).";

  const activeFooter = isSoniox
    ? `${keyterms.length} keyterm${keyterms.length !== 1 ? "s" : ""} active · sent as Soniox context.terms (free)`
    : `${keyterms.length} keyterm${keyterms.length !== 1 ? "s" : ""} active · +$0.05/hr surcharge will apply (ElevenLabs)`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Label className="flex items-center gap-2">
          <Tag className="size-4 text-slate-600" />
          <span className="text-sm font-medium">Keyterms <span className="text-slate-400 font-normal">({labelHelper})</span></span>
          {isSoniox && (
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px] font-normal">
              <Sparkles className="size-2.5 mr-1" /> free
            </Badge>
          )}
        </Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={loadDefaults}
          className="h-7 text-xs"
        >
          Load Bajaj defaults
        </Button>
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <Input
          type="text"
          placeholder="Add a keyterm (e.g. 'Bajaj Auto Credit') and press Enter"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={disabled}
          className="text-sm"
        />
        <Button type="submit" disabled={disabled || !draft.trim()} variant="outline" size="sm" className="h-9 px-3">
          <Plus className="size-4 mr-1" /> Add
        </Button>
      </form>

      {keyterms.length === 0 ? (
        <p className="text-xs text-slate-500 italic">{emptyHelper}</p>
      ) : (
        <div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {keyterms.map((t) => (
              <Badge
                key={t}
                variant="secondary"
                className="bg-slate-100 text-slate-700 hover:bg-slate-200 pl-2.5 pr-1 py-0.5 font-normal"
              >
                {t}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => remove(t)}
                    className="ml-1 hover:text-red-600 rounded-full"
                    aria-label={`Remove ${t}`}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </Badge>
            ))}
          </div>
          <p className="text-xs text-slate-500">{activeFooter}</p>
        </div>
      )}
    </div>
  );
};
