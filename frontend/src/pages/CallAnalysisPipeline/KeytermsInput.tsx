import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Plus, X, Tag } from "lucide-react";

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

interface KeytermsInputProps {
  keyterms: string[];
  onChange: (terms: string[]) => void;
  disabled?: boolean;
}

export const KeytermsInput = ({ keyterms, onChange, disabled }: KeytermsInputProps) => {
  const [draft, setDraft] = useState("");

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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2">
          <Tag className="size-4 text-slate-600" />
          <span>Keyterms (biases the STT toward Bajaj-specific vocabulary)</span>
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
        <p className="text-xs text-slate-500 italic">
          No keyterms — STT will run on its base model. Adding keyterms costs +$0.05/hr of audio but
          dramatically improves accuracy on domain terms (we recommend at least &quot;Bajaj Auto Credit&quot;,
          &quot;EMI&quot;, &quot;OTP&quot;, &quot;Aadhaar&quot;).
        </p>
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
          <p className="text-xs text-slate-500">
            {keyterms.length} keyterm{keyterms.length !== 1 ? "s" : ""} active · +$0.05/hr surcharge will apply
          </p>
        </div>
      )}
    </div>
  );
};
