"use client";

import type { GarmentType } from "@/lib/catalog/garment-types";
import { FIT_PREFERENCE_LABEL, FIT_PREFERENCES, fitInputSchema, fitReport, type FitInput, type FitPreference } from "@/lib/fit/fit";
import type { Size } from "@/lib/generated/prisma/enums";
import { cn } from "@/lib/utils";

// "Your fit" in the try-on panel: height, weight and a Fitted / Regular / Relaxed choice give an
// estimated fit report for each size and a recommended size; the try-on then shows that size on you.

export type FitGarment = { type: GarmentType; sizes: readonly Size[]; lengthCm: number | null };

export type FitDraft = { height: string; weight: string; preference: FitPreference; size: Size | null; remember: boolean };

/** The draft as a valid fit input, or null while height or weight is missing or out of range. */
export function fitInputOf(draft: FitDraft): FitInput | null {
  const parsed = fitInputSchema.safeParse({ heightCm: draft.height, weightKg: draft.weight, preference: draft.preference });
  return parsed.success ? parsed.data : null;
}

const STATUS_WORDS = { tight: "tight", good: "fits", loose: "loose" } as const;

export function FitSection({
  garment,
  noun,
  draft,
  onChange,
  savedProfile,
  onForget,
  disabled,
}: {
  garment: FitGarment;
  noun: string;
  draft: FitDraft;
  onChange: (draft: FitDraft) => void;
  savedProfile: boolean;
  onForget: () => void;
  disabled: boolean;
}) {
  const input = fitInputOf(draft);
  const problem = draft.height !== "" && draft.weight !== "" && !input ? fitInputSchema.safeParse({ heightCm: draft.height, weightKg: draft.weight, preference: draft.preference }).error?.issues[0]?.message : null;
  const report = input ? fitReport(garment.type, input, garment.sizes, draft.size, garment.lengthCm) : null;
  const set = (patch: Partial<FitDraft>) => onChange({ ...draft, ...patch });

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-3" data-testid="fit-section" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">Your fit (optional)</legend>
      <p className="text-xs text-muted-foreground">Add your height and weight to see how each size fits you, and the try-on shows that size on you.</p>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs">
          Height (cm)
          <input
            type="number"
            inputMode="numeric"
            min={120}
            max={220}
            className="h-8 w-24 rounded-md border bg-background px-2 text-sm"
            value={draft.height}
            onChange={(e) => set({ height: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Weight (kg)
          <input
            type="number"
            inputMode="numeric"
            min={30}
            max={200}
            className="h-8 w-24 rounded-md border bg-background px-2 text-sm"
            value={draft.weight}
            onChange={(e) => set({ weight: e.target.value })}
          />
        </label>
        <div className="flex flex-col gap-1 text-xs">
          <span id="fit-preference">How you like it to fit</span>
          <div className="flex gap-1" role="radiogroup" aria-labelledby="fit-preference">
            {FIT_PREFERENCES.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={draft.preference === p}
                onClick={() => set({ preference: p })}
                className={cn("h-8 rounded-md border px-2.5 text-sm", draft.preference === p ? "bg-foreground text-background" : "bg-background hover:bg-muted")}
              >
                {FIT_PREFERENCE_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-xs">
          Size to try
          <select className="h-8 rounded-md border bg-background px-2 text-sm" value={draft.size ?? ""} onChange={(e) => set({ size: garment.sizes.find((s) => s === e.target.value) ?? null })}>
            <option value="">Choose…</option>
            {garment.sizes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}

      {report && (
        <div className="flex flex-col gap-2 text-sm" data-testid="fit-report" aria-live="polite">
          {report.recommended && (
            <p>
              Recommended for a {FIT_PREFERENCE_LABEL[draft.preference].toLowerCase()} fit: <strong data-testid="fit-recommended">{report.recommended}</strong>
              {draft.size !== report.recommended && (
                <button type="button" className="ml-2 text-xs underline" onClick={() => set({ size: report.recommended })}>
                  Try {report.recommended}
                </button>
              )}
            </p>
          )}
          {report.chosen && (
            <table className="w-full max-w-md text-xs">
              <caption className="sr-only">How size {report.chosen.size} fits you</caption>
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 font-normal">Size {report.chosen.size}</th>
                  <th className="py-1 font-normal">You (est.)</th>
                  <th className="py-1 font-normal">Made for</th>
                  <th className="py-1 font-normal">Fit</th>
                </tr>
              </thead>
              <tbody>
                {report.chosen.lines.map((line) => (
                  <tr key={line.label} className="border-t">
                    <td className="py-1">{line.label}</td>
                    <td className="py-1 tabular-nums">{Math.round(line.bodyCm)} cm</td>
                    <td className="py-1 tabular-nums">
                      {line.rangeCm[0]}–{line.rangeCm[1]} cm
                    </td>
                    <td className={cn("py-1", line.status === "tight" && "text-destructive", line.status === "loose" && "text-amber-700 dark:text-amber-400")}>
                      {line.status === "good" ? "fits" : `${STATUS_WORDS[line.status]} by ${line.byCm} cm`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {report.chosen && (
            <p className="text-xs" data-testid="fit-length">
              {report.hem ? `Length: the hem lands ${report.hem.words} on you.` : `Length: not listed for this ${noun}.`}
            </p>
          )}
          <p className="text-xs text-muted-foreground">Body measurements are estimated from your height and weight, so treat them as a guide.</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="size-4" checked={draft.remember} onChange={(e) => set({ remember: e.target.checked })} />
          Remember my height, weight and fit on my account
        </label>
        {savedProfile && (
          <button type="button" className="text-destructive underline" onClick={onForget}>
            Forget them
          </button>
        )}
      </div>
    </fieldset>
  );
}
