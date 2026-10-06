import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PHASES, type PhaseNumber } from "@/lib/phases";

type PhasePlaceholderProps = {
  title: string;
  phase: PhaseNumber;
  features: readonly string[];
};

export function PhasePlaceholder({ title, phase, features }: PhasePlaceholderProps) {
  return (
    <Card className="mx-auto w-full max-w-2xl" data-testid="phase-placeholder">
      <CardHeader>
        <Badge variant="secondary" className="w-fit">
          Coming in Phase {phase}: {PHASES[phase]}
        </Badge>
        <CardTitle className="text-2xl">{title}</CardTitle>
        <CardDescription>This page is a placeholder. Nothing here is functional yet.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
