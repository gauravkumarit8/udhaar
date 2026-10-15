/**
 * The app's one money formatter.
 *
 * Every amount anybody sees goes through `formatMoney` now - it replaced the
 * four copies of `formatINR` that each screen used to carry - so this is the
 * smallest surface with the largest blast radius in the revamp. The rules it
 * is held to:
 *
 *   - Indian digit grouping (1,23,456), because ₹12,34,567 is how the number is
 *     read here and ₹1,234,567 is how it is misread.
 *   - No decimal tail on whole rupees, two decimals when there is a fraction -
 *     a part payment of ₹1,234.50 must not be shown as ₹1,235.
 *   - A minus sign before the symbol, never after it.
 */
import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneyShort } from "@/components/ui";

describe("formatMoney", () => {
  it("writes whole rupees without a decimal tail", () => {
    expect(formatMoney(4500)).toBe("₹4,500");
    expect(formatMoney(0)).toBe("₹0");
    expect(formatMoney(1)).toBe("₹1");
  });

  it("keeps the paise when there are any", () => {
    expect(formatMoney(1234.5)).toBe("₹1,234.50");
    expect(formatMoney(1234.56)).toBe("₹1,234.56");
    // Floating-point noise must not invent a fraction.
    expect(formatMoney(0.1 + 0.2)).toBe("₹0.30");
    expect(formatMoney(99.999)).toBe("₹100");
  });

  it("groups digits the Indian way", () => {
    expect(formatMoney(100000)).toBe("₹1,00,000");
    expect(formatMoney(12345678)).toBe("₹1,23,45,678");
    expect(formatMoney(1000)).toBe("₹1,000");
  });

  it("puts the sign before the symbol", () => {
    expect(formatMoney(-500)).toBe("-₹500");
    expect(formatMoney(-1234.5)).toBe("-₹1,234.50");
  });

  it("survives what the API actually sends", () => {
    // Postgres numerics arrive as strings, and do not always arrive at all.
    expect(formatMoney("4500.00")).toBe("₹4,500");
    expect(formatMoney("1234.50")).toBe("₹1,234.50");
    expect(formatMoney("")).toBe("₹0");
    expect(formatMoney("not a number")).toBe("₹0");
    expect(formatMoney(NaN)).toBe("₹0");
    expect(formatMoney(Infinity)).toBe("₹0");
  });
});

describe("formatMoneyShort", () => {
  it("is for labels, not balances", () => {
    expect(formatMoneyShort(500)).toBe("₹500");
    expect(formatMoneyShort(45000)).toBe("₹45k");
    expect(formatMoneyShort(120000)).toBe("₹1.2L");
    expect(formatMoneyShort(23000000)).toBe("₹2.3Cr");
  });

  it("does not print a trailing .0", () => {
    expect(formatMoneyShort(50000)).toBe("₹50k");
    expect(formatMoneyShort(100000)).toBe("₹1L");
  });
});
