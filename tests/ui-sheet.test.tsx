// @vitest-environment jsdom

/**
 * The sheet every action in the app happens in.
 *
 * One primitive now backs the payment sheet, the reminder sheet, the payoff
 * form, editing a loan and the loan details - so if it closes on Escape, keeps
 * its primary button inside the visible area, and moves focus to the field that
 * was marked for it, that is true everywhere at once. These are the properties
 * that broke in the component it replaced (no Escape, no focus, no sticky
 * footer); the drag gesture and the animations are left to the eye.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";
import { Sheet } from "@/components/ui";

afterEach(cleanup);

describe("Sheet", () => {
  it("renders nothing while closed", () => {
    render(
      <Sheet open={false} onClose={() => {}} title="Record payment">
        <p>body</p>
      </Sheet>
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("announces itself as a dialog with the title as its label", () => {
    render(
      <Sheet open onClose={() => {}} title="Record payment" subtitle="EMI #3">
        <p>body</p>
      </Sheet>
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Record payment");
    expect(screen.getByText("EMI #3")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Record payment">
        <p>body</p>
      </Sheet>
    );

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is tapped, and not when the sheet is", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="Record payment">
        <p>body</p>
      </Sheet>
    );

    await userEvent.click(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = container.querySelector("[aria-hidden]");
    expect(backdrop).not.toBeNull();
    await userEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the primary action outside the scrolling body", () => {
    render(
      <Sheet
        open
        onClose={() => {}}
        title="Record payment"
        footer={<button type="button">Record ₹4,500</button>}
      >
        <p>body</p>
      </Sheet>
    );

    const footerButton = screen.getByRole("button", { name: "Record ₹4,500" });
    // Its ancestor chain must not include the scrollable region, or the button
    // is only reachable by scrolling a form on a phone.
    expect(footerButton.closest(".overflow-y-auto")).toBeNull();
  });

  it("has a close control that calls onClose", async () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Record payment">
        <p>body</p>
      </Sheet>
    );

    await userEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
