/**
 * Which build is this?
 *
 * `/api/health` reports the commit the running code came from, because "is my
 * deploy live?" has to be answerable from outside. On 2026-10-14 a release went
 * to production and the app was serving it correctly with its migration
 * unapplied; nothing could tell the two apart except a hand-written probe, and
 * the deploy looked successful.
 *
 * The value comes from whichever host set one:
 *
 *   - `RENDER_GIT_COMMIT`      - Render, on services it builds from a repo
 *   - `GITHUB_SHA`             - GitHub Actions, when the image is built there
 *   - `NEXT_PUBLIC_GIT_SHA`    - baked into the image by a `--build-arg`
 *   - `GIT_COMMIT`             - anyone else, Fly/Docker Compose in CI
 *
 * Null when nobody said - reported honestly as unknown rather than guessed.
 */
const COMMIT_ENV_VARS = [
  "RENDER_GIT_COMMIT",
  "GITHUB_SHA",
  "NEXT_PUBLIC_GIT_SHA",
  "GIT_COMMIT",
] as const;

export interface BuildInfo {
  /** The full commit, or null when the host did not say which one it is. */
  commit: string | null;
  /** First 7 characters, for reading in a log or a health page. */
  short: string | null;
}

export function resolveBuildInfo(env: Record<string, string | undefined> = process.env): BuildInfo {
  for (const name of COMMIT_ENV_VARS) {
    const value = env[name]?.trim();
    // Guard against a value that is a placeholder rather than a commit: Render
    // and Actions both leave these unset rather than empty, but a compose file
    // with `GIT_COMMIT=` would otherwise read as a real answer.
    if (value && /^[0-9a-f]{7,40}$/i.test(value)) {
      return { commit: value, short: value.slice(0, 7) };
    }
  }

  return { commit: null, short: null };
}
