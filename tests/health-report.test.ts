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

/**
 * What a stranger is allowed to learn from a public endpoint.
 *
 * `/api/health` must stay usable anonymously (uptime ping, deploy verifier) and
 * it used to answer with the database host, the OTP mode's "123456 for every
 * number" sentence, and which integrations are configured. The redaction has to
 * be fail-closed: a check that does not declare a public form must not leak its
 * real detail by accident.
 */
describe("buildHealthReport redaction", () => {
  const build = { commit: "abc1234def", short: "abc1234" };

  it("keeps the verdict and the commit public", () => {
    const { status, body } = buildHealthReport(
      [{ name: "database connection", status: "ok", detail: "query succeeded", publicDetail: "query succeeded" }],
      build,
      new Date("2026-01-01T00:00:00.000Z"),
      { redact: true }
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.commit).toBe("abc1234def");
    expect(body.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("shows the public form of a check when it has one", () => {
    const { body } = buildHealthReport(
      [{ name: "DATABASE_URL", status: "ok", detail: "set → ep-secret.neon.tech:5432/neondb", publicDetail: "set" }],
      build,
      new Date(),
      { redact: true }
    );
    expect(body.checks[0].detail).toBe("set");
    expect(JSON.stringify(body)).not.toContain("neon.tech");
  });

  it("hides a detail that has no public form, rather than guessing", () => {
    const { body } = buildHealthReport(
      [{ name: "optional integrations", status: "ok", detail: "proofs: configured (private)" }],
      build,
      new Date(),
      { redact: true }
    );
    expect(body.checks[0].detail).toMatch(/hidden/);
    expect(JSON.stringify(body)).not.toContain("configured (private)");
  });

  it("does not hand a stranger the fix that names a host or a command", () => {
    const { body } = buildHealthReport(
      [
        {
          name: "database connection",
          status: "fail",
          detail: "Authentication failed: password authentication failed for user \"postgres\"",
          fix: "Re-copy the connection string from Neon → Connect.",
          publicFix: "Check the service logs.",
        },
      ],
      build,
      new Date(),
      { redact: true }
    );
    expect(body.ok).toBe(false);
    expect(body.firstProblem).toBe("database connection");
    expect(body.action).toBe("Check the service logs.");
    expect(JSON.stringify(body)).not.toContain("password authentication failed");
    expect(JSON.stringify(body)).not.toContain("Neon");
  });

  it("points a stranger at the logs when a failure has no public fix", () => {
    const { body } = buildHealthReport(
      [{ name: "schema", status: "fail", detail: "missing column: loans.created_by_user_id" }],
      build,
      new Date(),
      { redact: true }
    );
    expect(body.action).toMatch(/HEALTH_TOKEN/);
    expect(JSON.stringify(body)).not.toContain("created_by_user_id");
  });

  it("still tells the token-holder everything", () => {
    const checks = [
      { name: "DATABASE_URL", status: "ok" as const, detail: "set → ep-secret.neon.tech:5432/neondb", publicDetail: "set" },
    ];
    const { body } = buildHealthReport(checks, build, new Date(), { redact: false });
    expect(body.checks[0].detail).toContain("neon.tech");
  });

  it("defaults to the full detail (the route passes redact explicitly)", () => {
    const { body } = buildHealthReport(
      [{ name: "DATABASE_URL", status: "ok", detail: "set → db.example.com", publicDetail: "set" }],
      build
    );
    expect(body.checks[0].detail).toContain("db.example.com");
  });
});
