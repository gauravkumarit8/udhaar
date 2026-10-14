import { describe, expect, it } from "vitest";
import { resolveBuildInfo } from "@/lib/build-info";

describe("resolveBuildInfo", () => {
  it("reports what Render tells it", () => {
    const info = resolveBuildInfo({ RENDER_GIT_COMMIT: "3c138329e6067185666e01f85c35501316eafe53" });

    expect(info.commit).toBe("3c138329e6067185666e01f85c35501316eafe53");
    expect(info.short).toBe("3c13832");
  });

  it("falls back through the hosts that might have set it", () => {
    expect(resolveBuildInfo({ GITHUB_SHA: "ff3f098abc123" }).short).toBe("ff3f098");
    expect(resolveBuildInfo({ NEXT_PUBLIC_GIT_SHA: "dd1c084abc123" }).short).toBe("dd1c084");
    expect(resolveBuildInfo({ GIT_COMMIT: "9eb28b6abc123" }).short).toBe("9eb28b6");
  });

  it("prefers the host's own answer when several are set", () => {
    const info = resolveBuildInfo({
      RENDER_GIT_COMMIT: "aaaaaaa1111111",
      GITHUB_SHA: "bbbbbbb2222222",
    });

    expect(info.short).toBe("aaaaaaa");
  });

  it("says unknown rather than inventing a commit", () => {
    expect(resolveBuildInfo({})).toEqual({ commit: null, short: null });
  });

  it("ignores empty and placeholder values", () => {
    // A compose file with `GIT_COMMIT=` (or "unknown") must not read as a
    // commit, or the deploy check would compare two non-answers.
    for (const value of ["", "   ", "unknown", "local", "HEAD", "dev"]) {
      expect(resolveBuildInfo({ GIT_COMMIT: value }).commit).toBeNull();
    }
  });

  it("accepts short and full hex ids alike", () => {
    expect(resolveBuildInfo({ GITHUB_SHA: "abc1234" }).commit).toBe("abc1234");
    expect(
      resolveBuildInfo({ GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678" }).commit
    ).toHaveLength(40);
  });
});
