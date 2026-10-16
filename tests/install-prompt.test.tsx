// @vitest-environment jsdom

/**
 * The one-tap install.
 *
 * The event `beforeinstallprompt` is the only way a page can install itself,
 * and it is awkward in three ways that are worth pinning down: it arrives only
 * when the browser feels like it, the prompt it carries can be used exactly
 * once, and the choice comes back asynchronously. A hook that got any of that
 * wrong would either do nothing on tap or offer a button that quietly stops
 * working after the first try.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";

function Probe() {
  const { canInstall, installed, install } = useInstallPrompt();
  return (
    <div>
      <span data-testid="can">{String(canInstall)}</span>
      <span data-testid="installed">{String(installed)}</span>
      <button onClick={() => void install()}>install</button>
    </div>
  );
}

/** The event Chrome fires, with a prompt that records how often it was asked. */
function offerInstall(outcome: "accepted" | "dismissed" = "accepted") {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event("beforeinstallprompt") as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.prompt = prompt;
  event.userChoice = Promise.resolve({ outcome });
  act(() => {
    window.dispatchEvent(event);
  });
  return prompt;
}

afterEach(cleanup);

describe("useInstallPrompt", () => {
  it("offers nothing until the browser says the app is installable", () => {
    render(<Probe />);
    expect(screen.getByTestId("can").textContent).toBe("false");
    expect(screen.getByTestId("installed").textContent).toBe("false");
  });

  it("offers one tap once the browser has offered the prompt", () => {
    render(<Probe />);
    offerInstall();
    expect(screen.getByTestId("can").textContent).toBe("true");
  });

  it("shows the prompt, reports what was chosen, and marks it installed", async () => {
    render(<Probe />);
    const prompt = offerInstall("accepted");

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("installed").textContent).toBe("true");
  });

  it("stops offering the prompt after one use, because it cannot be reused", async () => {
    render(<Probe />);
    offerInstall("dismissed");

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    // Dismissed means not installed - but the prompt is spent either way, so
    // the button must not sit there pretending it still works.
    expect(screen.getByTestId("installed").textContent).toBe("false");
    expect(screen.getByTestId("can").textContent).toBe("false");
  });

  it("notices an install that happened outside the button", () => {
    render(<Probe />);
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(screen.getByTestId("installed").textContent).toBe("true");
    expect(screen.getByTestId("can").textContent).toBe("false");
  });

  it("takes its listeners down with the component", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Probe />);
    unmount();

    const removed = remove.mock.calls.map((call) => call[0]);
    expect(removed).toContain("beforeinstallprompt");
    expect(removed).toContain("appinstalled");
    remove.mockRestore();
  });
});
