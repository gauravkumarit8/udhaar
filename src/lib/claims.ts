/**
 * Answering a claim.
 *
 * In 2-side mode a marked payment is a claim: it reaches the schedule only once
 * the other side confirms it, and until then the EMI is open and whoever paid is
 * waiting. There are now three places somebody can be faced with that - the card
 * at the top of the loan screen, the notification in Activity, and the strip on
 * the home screen - and they must all send the same thing and report the same
 * way. This is that one thing.
 *
 * Client-side and framework-free: it returns a result rather than throwing, so
 * each caller decides how to show a failure without three copies of the parsing.
 */
/** The three things the confirm route accepts on a pending payment. */
export type ClaimAction = "confirm" | "reject" | "withdraw";

export interface ClaimResult {
  ok: boolean;
  /** The API's own words on failure ("you can't confirm your own payment"). */
  error?: string;
}

export async function answerClaim(paymentId: string, action: ClaimAction): Promise<ClaimResult> {
  try {
    const res = await fetch(`/api/payments/${paymentId}/confirm`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        ok: false,
        // Errors here are meaningful - "this EMI already moved on", "payment
        // already processed" - so the message is passed through rather than
        // replaced with a generic apology.
        error: body.error ?? "Couldn't update that payment.",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error - the payment wasn't updated." };
  }
}
