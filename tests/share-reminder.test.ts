import { describe, expect, it } from "vitest";
import { buildReminderShare, toE164India } from "@/lib/share-reminder";

/**
 * The reminder that has to work for someone who has never installed the app.
 * These cases pin the two things that make it work - a message that names the
 * right person and says the right amount, and deep links that actually open
 * WhatsApp/SMS addressed to the borrower.
 */
describe("toE164India", () => {
  it("prefixes a stored 10-digit mobile with 91", () => {
    expect(toE164India("9876500022")).toBe("919876500022");
  });

  it("keeps an already-qualified number as it is", () => {
    expect(toE164India("919876500022")).toBe("919876500022");
  });

  it("strips spaces, dashes and a leading plus", () => {
    expect(toE164India("+91 98765-00022")).toBe("919876500022");
  });

  it("does not invent digits for an empty value", () => {
    expect(toE164India("")).toBe("");
  });
});

describe("buildReminderShare", () => {
  const input = {
    lenderName: "Vikram",
    borrowerName: "Sneha Sharma",
    borrowerMobile: "9876500022",
    amount: 4080.27,
    dueDate: "14 Sep 2026",
    upiLink: "upi://pay?pa=vikram@ybl&am=4080.27",
  };

  it("names the lender and the borrower's first name, with the amount and date", () => {
    const share = buildReminderShare(input);
    expect(share.text).toContain("Hi Sneha,");
    expect(share.text).toContain("Vikram here");
    expect(share.text).toContain("₹4,080.27");
    expect(share.text).toContain("14 Sep 2026");
  });

  it("formats the amount in Indian style, to the paisa", () => {
    expect(buildReminderShare({ ...input, amount: 125000.5 }).text).toContain("₹1,25,000.50");
  });

  it("includes the UPI link when there is one, and no dead line when there isn't", () => {
    expect(buildReminderShare(input).text).toContain("upi://pay?pa=vikram@ybl");
    const withoutUpi = buildReminderShare({ ...input, upiLink: null });
    expect(withoutUpi.text).not.toContain("UPI");
    expect(withoutUpi.upiLink).toBeNull();
  });

  it("addresses the WhatsApp link to the borrower's number, text pre-filled", () => {
    const share = buildReminderShare(input);
    expect(share.whatsappUrl.startsWith("https://wa.me/919876500022?text=")).toBe(true);

    // The encoded body must decode back to the message itself.
    const body = decodeURIComponent(share.whatsappUrl.split("?text=")[1]);
    expect(body).toBe(share.text);
  });

  it("addresses the SMS link the same way", () => {
    const share = buildReminderShare(input);
    expect(share.smsUrl.startsWith("sms:+919876500022?")).toBe(true);
    expect(decodeURIComponent(share.smsUrl.split("?&body=")[1])).toBe(share.text);
  });

  it("escapes text that would otherwise break the URL", () => {
    const share = buildReminderShare({ ...input, borrowerName: "A&B #1" });
    // A raw & would truncate the message the borrower receives.
    expect(share.whatsappUrl).not.toMatch(/text=[^&]*[^%]&[^%]/);
    expect(decodeURIComponent(share.whatsappUrl.split("?text=")[1])).toBe(share.text);
  });

  it("copes with a missing name instead of writing 'Hi ,'", () => {
    const share = buildReminderShare({ ...input, borrowerName: "   " });
    expect(share.text.startsWith("Hi there,")).toBe(true);
  });

  it("never claims anything about delivery", () => {
    // The lender sends it; the app only prepares it. A message that says
    // "sent by Udhaar" would be a lie the lender would have to correct.
    const share = buildReminderShare(input);
    expect(share.text.toLowerCase()).not.toContain("udhaar");
    expect(share.text.toLowerCase()).not.toContain("sent");
  });

  it("uses the same words for every channel", () => {
    const share = buildReminderShare(input);
    expect(decodeURIComponent(share.smsUrl.split("?&body=")[1])).toBe(share.text);
    expect(decodeURIComponent(share.whatsappUrl.split("?text=")[1])).toBe(share.text);
  });
});
