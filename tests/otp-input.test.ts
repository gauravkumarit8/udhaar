/**
 * Filling the six OTP boxes.
 *
 * Every case here is one that a person hits while logging in, and two of them
 * were broken until they moved into `applyOtpInput`: pasting the code from an
 * SMS app (five digits were discarded) and letting the phone autofill it into
 * the first box (all six arrived in one change event and five were discarded).
 * Money apps are logged into in a hurry, usually from a notification.
 */
import { describe, expect, it } from "vitest";
import { OTP_LENGTH, applyOtpInput, nextOtpFocus, otpValue } from "@/lib/otp-input";

const empty = Array.from({ length: OTP_LENGTH }, () => "");

describe("applyOtpInput", () => {
  it("fills one box when one digit is typed", () => {
    expect(applyOtpInput(empty, 2, "7")).toEqual(["", "", "7", "", "", ""]);
  });

  it("keeps the rest of the code when a box is one digit", () => {
    const digits = ["1", "2", "3", "", "", ""];
    expect(applyOtpInput(digits, 0, "9")).toEqual(["9", "2", "3", "", "", ""]);
  });

  it("clears only the box that was emptied", () => {
    const digits = ["1", "2", "3", "4", "5", ""];
    expect(applyOtpInput(digits, 1, "")).toEqual(["1", "", "3", "4", "5", ""]);
  });

  it("spreads a pasted code across every box", () => {
    expect(applyOtpInput(empty, 0, "123456")).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("starts a pasted code at the first box, whichever box received it", () => {
    // A code is read from the start: pasting into box 3 must not turn
    // "123456" into "456" in the last three boxes.
    expect(applyOtpInput(empty, 3, "123456")).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("takes the autofilled code the same way as a paste", () => {
    // What iOS and Android deliver when the code is tapped in the suggestion
    // bar: the whole thing, in one event, into the focused box.
    expect(applyOtpInput(empty, 0, "098765")).toEqual(["0", "9", "8", "7", "6", "5"]);
  });

  it("fills forward from where a partial paste landed", () => {
    expect(applyOtpInput(empty, 2, "789")).toEqual(["", "", "7", "8", "9", ""]);
  });

  it("drops anything that is not a digit", () => {
    expect(applyOtpInput(empty, 0, "12 34-56")).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(applyOtpInput(empty, 0, "1234567890")).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("does not grow the row of boxes", () => {
    expect(applyOtpInput(empty, 4, "987654")).toHaveLength(OTP_LENGTH);
  });

  it("never invents digits that were not there", () => {
    const digits = ["", "", "", "", "", ""];
    expect(applyOtpInput(digits, 1, "5")).toEqual(["", "5", "", "", "", ""]);
  });
});

describe("otpValue", () => {
  it("returns the code once every box holds a digit", () => {
    expect(otpValue(["1", "2", "3", "4", "5", "6"])).toBe("123456");
  });

  it("returns nothing while a box is still empty", () => {
    expect(otpValue(["1", "2", "3", "4", "5", ""])).toBeNull();
  });

  it("returns nothing if a box somehow holds more than a digit", () => {
    expect(otpValue(["1", "2", "3", "4", "5", "67"])).toBeNull();
  });
});

describe("nextOtpFocus", () => {
  it("advances to the next box while typing a code", () => {
    expect(nextOtpFocus(["1", "", "", "", "", ""])).toBe(1);
  });

  it("jumps to the first box a paste left empty", () => {
    expect(nextOtpFocus(["1", "2", "", "4", "5", ""])).toBe(2);
  });

  it("sits on the last box once the code is full", () => {
    expect(nextOtpFocus(["1", "2", "3", "4", "5", "6"])).toBe(5);
  });

  it("goes back to a box that was just cleared", () => {
    expect(nextOtpFocus(["1", "2", "", "4", "5", "6"])).toBe(2);
  });
});
