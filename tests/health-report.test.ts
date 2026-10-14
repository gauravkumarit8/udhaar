import { describe, expect, it } from "vitest";
import { buildHealthReport, type HealthCheck } from "@/lib/health-report";
import { resolveBuildInfo } from "@/lib/build-info";

const ok: HealthCheck[] = [
  { name: "DATABASE_URL", status: "ok", detail: "set" },
  { name: "database connection", status: "ok", detail: "query succeeded (select 1)" },
];

const broken: HealthCheck[] = [
  ...ok,
  {
    name: "schema",
    status: "fail",
    detail: "missing columns: loans.lender_name",
    fix: "npm run db:push (or npm run db:migrate)",
  },
];

const stamped = resolveBuildInfo({ RENDER_GIT_COMMIT: "3ca3c81f00d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8" });
const unstamped = resolveBuildInfo({});

describe("the health body", () => {
  it("names the commit that is answering", () => {
    // The bug this guards: the route imported the build info and never put it
    // in the response, so every deploy was anonymous and a release could be
    // "verified" while the previous build was still serving.
    const { body } = buildHealthReport(ok, stamped, new Date("2026-10-14T10:00:00Z"));
    expect(body.commit).toBe("3ca3c81f00d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8");
    expect(body.shortCommit).toBe("3ca3c81");
  });

  it("still names it when the app is failing", () => {
    const { body, status } = buildHealthReport(broken, stamped, new Date("2026-10-14T10:00:00Z"));
    expect(status).toBe(503);
    expect(body.commit).toBe("3ca3c81f00d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8");
  });

  it("says so, rather than guessing, when nobody stamped a build", () => {
    const { body } = buildHealthReport(ok, unstamped, new Date("2026-10-14T10:00:00Z"));
    expect(body.commit).toBeNull();
    expect(body.shortCommit).toBeNull();
    expect("commit" in body).toBe(true);
  });

  it("reports healthy with 200 and no problem field", () => {
    const { body, status } = buildHealthReport(ok, stamped, new Date("2026-10-14T10:00:00Z"));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.firstProblem).toBeUndefined();
    expect(body.action).toBeUndefined();
    expect(body.timestamp).toBe("2026-10-14T10:00:00.000Z");
  });

  it("reports the first failure with its fix", () => {
    const { body, status } = buildHealthReport(broken, stamped, new Date("2026-10-14T10:00:00Z"));
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.firstProblem).toBe("schema");
    expect(body.action).toBe("npm run db:push (or npm run db:migrate)");
  });

  it("warnings alone do not make it unhealthy", () => {
    const warned: HealthCheck[] = [
      ...ok,
      { name: "OTP delivery", status: "warn", detail: "dummy mode - anyone can log in as any number" },
    ];
    const { body, status } = buildHealthReport(warned, stamped, new Date("2026-10-14T10:00:00Z"));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
