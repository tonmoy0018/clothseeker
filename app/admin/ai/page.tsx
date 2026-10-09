import type { Metadata } from "next";

import { getAiMetrics, LIMIT_FEATURES, type JobTypeMetrics } from "@/lib/admin/ai-metrics";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";

export const metadata: Metadata = { title: "AI — ClothSeeker admin" };

const JOB_LABEL = { DESIGN_ROUND: "AI design rounds", DRESS_MATCH: "Start from photo / description", TRY_ON: "Try-ons" } as const;
const LIMIT_LABEL = { DESIGN_ROUND: "AI rounds (10/day)", TRY_ON: "Try-ons (5/day)", SUBMISSIONS: "All AI requests (30/day)" } as const;
const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dhaka" });

function seconds(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function ago(date: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function Bars({ series, label }: { series: { day: Date; count: number }[]; label: string }) {
  const max = Math.max(1, ...series.map((s) => s.count));
  return (
    <div className="flex h-16 items-end gap-1" role="img" aria-label={`${label}: ${series.map((s) => `${day.format(s.day)} ${s.count}`).join(", ")}`}>
      {series.map((s) => (
        <span key={s.day.toISOString()} title={`${day.format(s.day)}: ${s.count}`} className="w-full rounded-t bg-foreground/70" style={{ height: `${Math.max(2, (s.count / max) * 100)}%` }} />
      ))}
    </div>
  );
}

function JobCard({ m, now }: { m: JobTypeMetrics; now: Date }) {
  const finished = m.today.SUCCEEDED + m.today.FAILED;
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4" data-testid={`ai-metrics-${m.type}`}>
      <h2 className="font-medium">{JOB_LABEL[m.type]}</h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Today</dt>
        <dd className="sm:col-span-2">
          {m.today.SUCCEEDED + m.today.FAILED + m.today.QUEUED + m.today.RUNNING} requests · {m.today.SUCCEEDED} done · {m.today.FAILED} failed
        </dd>
        <dt className="text-muted-foreground">Queue now</dt>
        <dd className="sm:col-span-2">
          {m.queued} waiting · {m.running} running{m.oldestQueuedAt ? ` · oldest ${ago(m.oldestQueuedAt, now)}` : ""}
        </dd>
        <dt className="text-muted-foreground">Average wait</dt>
        <dd className="sm:col-span-2">{seconds(m.averageWaitMs)}</dd>
        <dt className="text-muted-foreground">Average run</dt>
        <dd className="sm:col-span-2">{seconds(m.averageRunMs)}</dd>
        <dt className="text-muted-foreground">Failure rate</dt>
        <dd className="sm:col-span-2">
          {m.failureRate === null ? "—" : `${Math.round(m.failureRate * 100)}% of ${finished}`}
          {m.topFailures.length > 0 && <span className="text-muted-foreground"> ({m.topFailures.map((f) => `${f.value} ×${f.count}`).join(", ")})</span>}
        </dd>
      </dl>
      <div>
        <p className="mb-1 text-xs text-muted-foreground">Last 14 days</p>
        <Bars series={m.series} label={`${JOB_LABEL[m.type]} per day`} />
      </div>
    </section>
  );
}

export default async function AdminAiPage() {
  const admin = await requireAdmin();
  const now = new Date();
  const metrics = await getAiMetrics(getPrisma(), admin, now);
  const worker = metrics.workers[0];
  const workerAlive = worker ? now.getTime() - worker.lastSeenAt.getTime() < 2 * 60_000 : false;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">AI</h1>
        <p className="text-sm text-muted-foreground">How the AI features are doing. Days follow Dhaka time.</p>
      </div>

      <section className="flex flex-wrap gap-4" data-testid="ai-summary">
        <div className="rounded-xl border p-4">
          <div className="text-3xl font-semibold tabular-nums">{metrics.roundsToday}</div>
          <div className="text-sm text-muted-foreground">AI design rounds today</div>
        </div>
        <div className="rounded-xl border p-4">
          <div className="text-3xl font-semibold tabular-nums">{metrics.tryOnsToday}</div>
          <div className="text-sm text-muted-foreground">Try-ons today</div>
        </div>
        <div className="rounded-xl border p-4" data-testid="worker-status">
          <div className={workerAlive ? "text-lg font-semibold text-emerald-700 dark:text-emerald-400" : "text-lg font-semibold text-destructive"}>
            {worker ? (workerAlive ? "Worker running" : "Worker stopped") : "No worker seen yet"}
          </div>
          <div className="text-sm text-muted-foreground">
            {worker ? `Last seen ${ago(worker.lastSeenAt, now)} · planner ${worker.planner} · images ${worker.image} · try-on ${worker.tryOn}` : "Start it with pnpm worker."}
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        {metrics.jobs.map((m) => (
          <JobCard key={m.type} m={m} now={now} />
        ))}
      </div>

      <section className="flex flex-col gap-3 rounded-xl border p-4" data-testid="limit-hits">
        <h2 className="font-medium">Daily-limit hits</h2>
        <p className="text-sm text-muted-foreground">Customers refused because they reached a daily limit.</p>
        <ul className="flex flex-wrap gap-6 text-sm">
          {LIMIT_FEATURES.map((feature) => (
            <li key={feature}>
              <span className="text-xl font-semibold tabular-nums">{metrics.limitHitsToday[feature]}</span> <span className="text-muted-foreground">today · {LIMIT_LABEL[feature]}</span>
            </li>
          ))}
        </ul>
        <Bars series={metrics.limitHitSeries} label="Limit hits per day" />
      </section>
    </div>
  );
}
