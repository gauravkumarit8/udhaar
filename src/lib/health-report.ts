/**
 * The body `/api/health` answers with.
 *
 * Split out of the route because of a hole that shipped and stayed invisible:
 * the route imported the build info and never put it in the response, so every
 * deployed app reported an anonymous "healthy" and no release could be told
 * apart from the one before it - a green deploy tick while the previous build
 * was still serving. A pure function can be tested for exactly that.
 */
import type { BuildInfo } from "@/lib/build-info";

export type HealthStatus = "ok" | "warn" | "fail" | "skip";

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  detail: string;
  fix?: string;
}

export interface HealthBody {
  ok: boolean;
  /** The commit this build came from; null when nobody stamped one. */
  commit: string | null;
  /** First seven characters, for reading in a log. */
  shortCommit: string | null;
  checks: HealthCheck[];
  /** Only present when something failed: what broke, and how to fix it. */
  firstProblem?: string;
  action?: string;
  timestamp: string;
}

export function buildHealthReport(
  checks: HealthCheck[],
  build: BuildInfo,
  now: Date = new Date()
): { status: number; body: HealthBody } {
  const failed = checks.filter((check) => check.status === "fail");
  const healthy = failed.length === 0;

  return {
    status: healthy ? 200 : 503,
    body: {
      ok: healthy,
      // Carried in the failing body too: the moment you most need to know
      // which build is broken is the moment it is returning 503.
      commit: build.commit,
      shortCommit: build.short,
      checks,
      ...(healthy
        ? {}
        : {
            firstProblem: failed[0].name,
            action: failed[0].fix,
          }),
      timestamp: now.toISOString(),
    },
  };
}
