/**
 * The class-name joiner.
 *
 * This one has already caused a real bug: `<Card className="bg-brand">` (the
 * brand-coloured hero on three screens) renders from a base of `bg-surface`,
 * and two Tailwind utilities that set the same property resolve by the order
 * Tailwind emitted them in the stylesheet - not by the order they appear on the
 * element. In the built stylesheet `bg-surface` came last, so the hero was a
 * white card with near-white text on it, and no test could see it.
 *
 * `cx` reconciles instead: the caller's override always wins. These cases are
 * the exact pairs the app relies on.
 */
import { describe, expect, it } from "vitest";
import { cx } from "@/components/ui";

describe("cx", () => {
  it("keeps everything when nothing conflicts", () => {
    expect(cx("flex", "items-center", "gap-2")).toBe("flex items-center gap-2");
  });

  it("lets the caller's colour beat the primitive's own", () => {
    expect(cx("rounded-card border border-line bg-surface shadow-card", "bg-brand")).toBe(
      "rounded-card border border-line shadow-card bg-brand"
    );
    expect(cx("bg-surface-3 text-ink-2", "bg-black/15 text-brand-ink")).toBe(
      "bg-black/15 text-brand-ink"
    );
    expect(cx("bg-brand-soft text-brand-strong", "bg-black/15 text-brand-ink")).toBe(
      "bg-black/15 text-brand-ink"
    );
    expect(cx("bg-surface-2 text-ink hover:bg-surface-3", "text-bad")).toBe(
      "bg-surface-2 hover:bg-surface-3 text-bad"
    );
  });

  it("treats this app's radius steps as one group", () => {
    expect(cx("rounded-card", "rounded-control")).toBe("rounded-control");
    expect(cx("rounded-sheet", "rounded-card")).toBe("rounded-card");
  });

  it("lets a caller override the width and the track", () => {
    expect(cx("h-1.5 w-full rounded-full bg-surface-3", "bg-black/20")).toBe(
      "h-1.5 w-full rounded-full bg-black/20"
    );
    expect(cx("h-11 px-4", "w-full")).toBe("h-11 px-4 w-full");
  });

  it("passes through the app's own non-Tailwind classes", () => {
    expect(cx("tap inline-flex", "stagger", "animate-rise", "safe-bottom")).toBe(
      "tap inline-flex stagger animate-rise safe-bottom"
    );
  });

  it("drops nothing that is missing", () => {
    expect(cx("a", false, null, undefined, "b")).toBe("a b");
  });
});
