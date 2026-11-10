"use client";

import type { GarmentType } from "@/lib/catalog/garment-types";
import { fitInputSchema, fitReport, type BodyGirth, type FitInput } from "@/lib/fit/fit";
import type { Size } from "@/lib/generated/prisma/enums";
import { cn } from "@/lib/utils";

// "Your fit" in the try-on panel: height (the only thing the customer types) plus the measurements taken
// from their photo on this device give the size made for them and a fit report for the size they
// choose; the try-on then shows that size on them.

export type FitGarment = { type: GarmentType; sizes: readonly Size[]; lengthCm: number | null };

export type FitDraft = { height: string; size: Size | null; remember: boolean };

/** What the selected photo told us about the body. */
export type FitMeasure =
  | { kind: "no_photo" }
  | { kind: "measuring" }
  | { kind: "failed"; message: string }
  | { kind: "measured"; fullLength: boolean; girths: (heightCm: number) => BodyGirth[] };

/** The draft as a valid fit input, or null while the height is missing or out of range. */
export function fitInputOf(draft: FitDraft): FitInput | null {
  const parsed = fitInputSchema.safeParse({ heightCm: draft.height });
  return parsed.success ? parsed.data : null;
}

const STATUS_WORDS = { tight: "tight", good: "fits", loose: "loose" } as const;

function MeasureNote({ measure }: { measure: FitMeasure }) {
  const text =
    measure.kind === "no_photo"
      ? "Add a photo of you: we measure you from it, on this device."
      : measure.kind === "measuring"
        ? "Measuring you from your photo…"
        : measure.kind === "failed"
          ? `${measure.message} Without measurements we can't suggest a size; the length still shows.`
          : measure.fullLength
            ? "Measured from your photo."
            : "Measured from your photo. A full-length photo, head to feet, measures more accurately.";
  return (
    <p className={cn("text-xs", measure.kind === "failed" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")} data-testid="fit-measure">
      {text}
    </p>
  );
}

export function FitSection({
  garment,
  noun,
  draft,
  measure,
  onChange,
  savedProfile,
  onForget,
  disabled,
}: {
  garment: FitGarment;
  noun: string;
  draft: FitDraft;
  measure: FitMeasure;
  onChange: (draft: FitDraft) => void;
  savedProfile: boolean;
  onForget: () => void;
  disabled: boolean;
}) {
  const input = fitInputOf(draft);
  const problem = draft.height !== "" && !input ? fitInputSchema.safeParse({ heightCm: draft.height }).error?.issues[0]?.message : null;
  const girths = input && measure.kind === "measured" ? measure.girths(input.heightCm) : null;
  const report = input ? fitReport(garment.type, input, girths, garment.sizes, draft.size, garment.lengthCm) : null;
  const set = (patch: Partial<FitDraft>) => onChange({ ...draft, ...patch });

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-3" data-testid="fit-section" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">Your fit (optional)</legend>
      <p className="text-xs text-muted-foreground">Add your height and we measure the rest from your photo, to show how each size fits you; the try-on then shows that size on you.</p>
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
      {input && <MeasureNote measure={measure} />}

      {report && (
        <div className="flex flex-col gap-2 text-sm" data-testid="fit-report" aria-live="polite">
          {report.recommended && (
            <p>
              Your size: <strong data-testid="fit-recommended">{report.recommended}</strong>
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
                    <td className="py-1">
                      {line.label}
                      {line.estimated && " *"}
                    </td>
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
          {draft.size && (
            <p className="text-xs" data-testid="fit-length">
              {report.hem ? `Length: the hem lands ${report.hem.words} on you.` : `Length: not listed for this ${noun}.`}
            </p>
          )}
          {girths && (
            <p className="text-xs text-muted-foreground">
              {girths.some((g) => g.estimated) && "* Guessed from your other measurements: the photo doesn't show it. "}
              Like it looser or closer? Try the next size up or down. Measured from one photo, so treat them as a guide: loose clothes make you
              look bigger.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="size-4" checked={draft.remember} onChange={(e) => set({ remember: e.target.checked })} />
          Remember my height on my account
        </label>
        {savedProfile && (
          <button type="button" className="text-destructive underline" onClick={onForget}>
            Forget it
          </button>
        )}
      </div>
    </fieldset>
  );
}
