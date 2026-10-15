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
  /**
   * The same check, said without giving anything away.
   *
   * `/api/health` is deliberately public - an uptime ping and the deploy
   * verifier both call it anonymously - and it used to answer with the database
   * host, whether proofs and push are configured, and that the OTP is 123456
   * for every number. Useful to the owner, a reconnaissance report to anyone
   * else. When a check has this, that is what the public sees; without it, the
   * public sees nothing rather than the real detail (fail closed).
   */
  publicDetail?: string;
  /** Replaces `fix` in the public body, for the same reason. */
  publicFix?: string;
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

export interface HealthReportOptions {
  /** True for callers who did not present the health token. */
  redact?: boolean;
}

/** What a public caller is told instead of a detail they should not have. */
const HIDDEN = "hidden - send the health token for the full detail";

export function buildHealthReport(
  checks: HealthCheck[],
  build: BuildInfo,
  now: Date = new Date(),
  options: HealthReportOptions = {}
): { status: number; body: HealthBody } {
  const failed = checks.filter((check) => check.status === "fail");
  const healthy = failed.length === 0;
  const redact = options.redact ?? false;

  /*
   * The verdict stays public (`ok`, `checks[].status`, `firstProblem`) because
   * that is what an uptime ping and the deploy verifier need, and because the
   * failure is visible from the outside anyway. The *detail* - hostnames, which
   * integrations are configured, the OTP mode's warning text - is what changes:
   * only checks that say so in advance have a public form.
   */
  const exposed: HealthCheck[] = redact
    ? checks.map(({ name, status, publicDetail, publicFix }) => ({
        name,
        status,
        detail: publicDetail ?? HIDDEN,
        ...(publicFix ? { fix: publicFix } : {}),
      }))
    : checks;

  return {
    status: healthy ? 200 : 503,
    body: {
      ok: healthy,
      // Carried in the failing body too: the moment you most need to know
      // which build is broken is the moment it is returning 503.
      commit: build.commit,
      shortCommit: build.short,
      checks: exposed,
      ...(healthy
        ? {}
        : {
            firstProblem: failed[0].name,
            // A check may carry a fix that is safe to show anyone ("check the
            // logs"); when it does not, a stranger gets the generic pointer
            // instead of whatever the real fix would have revealed.
            action: redact
              ? (failed[0].publicFix ??
                "Open the service logs, or call /api/health with the HEALTH_TOKEN header for the full diagnosis.")
              : failed[0].fix,
          }),
      timestamp: now.toISOString(),
    },
  };
}
