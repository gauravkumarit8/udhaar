// @vitest-environment jsdom

/**
 * The primitives, as the screens actually use them.
 *
 * Two of these are regression tests with a scar behind them. The hero cards on
 * the home screen, the loan screen and the profile are `<Card className="bg-brand
 * text-brand-ink">` - a brand-coloured card with near-white text - and the
 * first version of them rendered white, because `bg-surface` won the stylesheet
 * against `bg-brand` on an element carrying both. Nothing else could see it:
 * not the type checker, not the unit tests, and not a screenshot in a sandbox
 * that has no browser. So it is asserted here, in the DOM, from now on.
 */
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Avatar, Badge, Button, Card, Money, Progress } from "@/components/ui";

afterEach(cleanup);

/**
 * The class list as tokens.
 *
 * Substring matching lies here: `hover:bg-brand-strong` contains "bg-brand",
 * and `bg-surface-2` contains "bg-surface", so a test written that way fails on
 * correct code and passes on broken code. Both directions worked out badly
 * enough to be worth a helper.
 */
function tokens(element: Element | null | undefined): string[] {
  return (element?.className ?? "").split(/\s+/).filter(Boolean);
}

describe("Card", () => {
  it("keeps a caller's colour instead of its own surface", () => {
    const { container } = render(
      <Card className="bg-brand text-brand-ink">
        <p>hero</p>
      </Card>
    );

    expect(tokens(container.firstElementChild)).toContain("bg-brand");
    expect(tokens(container.firstElementChild)).not.toContain("bg-surface");
    expect(tokens(container.firstElementChild)).toContain("text-brand-ink");
  });

  it("is a surface otherwise", () => {
    const { container } = render(<Card>plain</Card>);
    expect(tokens(container.firstElementChild)).toContain("bg-surface");
  });
});

describe("Avatar", () => {
  it("can be toned for a coloured surface", () => {
    const { container } = render(<Avatar name="Rahul" className="bg-black/15 text-brand-ink" />);
    expect(tokens(container.firstElementChild)).toContain("bg-black/15");
    expect(tokens(container.firstElementChild)).not.toContain("bg-brand-soft");
  });

  it("gives the same person the same colour every time", () => {
    const first = render(<Avatar name="Rahul Sharma" />).container.firstElementChild?.className;
    cleanup();
    const second = render(<Avatar name="Rahul Sharma" />).container.firstElementChild?.className;
    expect(first).toBe(second);
  });
});

describe("Badge", () => {
  it("takes an on-brand tint over its neutral tone", () => {
    render(<Badge className="bg-black/15 text-brand-ink">OWED TO YOU</Badge>);
    expect(tokens(screen.getByText("OWED TO YOU"))).toContain("bg-black/15");
    expect(tokens(screen.getByText("OWED TO YOU"))).not.toContain("bg-surface-3");
  });
});

describe("Progress", () => {
  it("reports its value to assistive technology and clamps what it draws", () => {
    const { container } = render(<Progress value={150} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    const fill = container.querySelector('[role="progressbar"] > div');
    expect((fill as HTMLElement).style.width).toBe("100%");
  });
});

describe("Button", () => {
  it("cannot be pressed twice while it is loading", () => {
    render(<Button loading>Record ₹4,500</Button>);
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("lets a caller's colour through", () => {
    render(<Button className="bg-bad">Delete</Button>);
    expect(tokens(screen.getByRole("button"))).toContain("bg-bad");
    expect(tokens(screen.getByRole("button"))).not.toContain("bg-brand");
  });
});

describe("Money", () => {
  it("renders the formatted amount in a tabular span", () => {
    render(<Money amount="1234.5" />);
    expect(tokens(screen.getByText("₹1,234.50"))).toContain("tabular-nums");
  });
});
