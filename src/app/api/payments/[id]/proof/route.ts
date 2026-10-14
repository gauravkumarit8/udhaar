import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { loans, payments } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isStorageConfigured, signedDeliveryUrl } from "@/lib/storage";
import { eq } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";

/**
 * Serves the payment proof screenshot to the two people on the loan.
 *
 * Why not just store a URL: proofs are bank/UPI screenshots. The old approach
 * saved Cloudinary's public delivery URL, which meant anyone who ever saw that
 * link - or found it in a log, a screenshot, a browser history - could open
 * somebody's payment proof forever. Now the asset itself is private and this
 * route is the only way in:
 *
 *   session → payment → loan → are you the lender or the borrower?
 *     yes → stream the image bytes
 *     no  → 404, so the response doesn't confirm whether a proof exists
 *
 * The browser never receives a Cloudinary URL: the server signs a delivery URL,
 * fetches it, and pipes the bytes. So there is nothing durable to leak, and
 * revoking access is just a matter of this check changing.
 */
async function handleGET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const [payment] = await db
    .select({
      id: payments.id,
      loanId: payments.loanId,
      proofUrl: payments.proofUrl,
      proofPublicId: payments.proofPublicId,
    })
    .from(payments)
    .where(eq(payments.id, id))
    .limit(1);

  if (!payment) {
    return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  }

  const [loan] = await db
    .select({ lenderId: loans.lenderId, borrowerId: loans.borrowerId })
    .from(loans)
    .where(eq(loans.id, payment.loanId))
    .limit(1);

  const allowed = loan && (loan.lenderId === session.id || loan.borrowerId === session.id);
  if (!allowed) {
    // Deliberately the same answer as "no such payment": a stranger should not
    // be able to probe for the existence of a proof.
    return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  }

  if (payment.proofPublicId) {
    if (!isStorageConfigured()) {
      return NextResponse.json(
        {
          error: "Cloudinary is not configured, so the proof can't be served.",
          action: "Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET, then reload.",
        },
        { status: 503 }
      );
    }

    let upstream: Response;
    try {
      upstream = await fetch(signedDeliveryUrl(payment.proofPublicId));
    } catch (err) {
      console.error("[proof] could not reach Cloudinary:", err);
      return NextResponse.json(
        { error: "Couldn't reach the proof store just now. Please try again." },
        { status: 502 }
      );
    }

    if (!upstream.ok || !upstream.body) {
      // Say what actually happened instead of rendering a broken image: 401
      // means the credentials/signature were rejected, 404 means the asset is
      // gone (deleted, or stored under a different account).
      const hint =
        upstream.status === 401
          ? " Cloudinary rejected the credentials - check CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET."
          : upstream.status === 404
            ? " The file is no longer in the proof store."
            : "";
      console.error("[proof] Cloudinary responded", upstream.status, payment.proofPublicId);
      return NextResponse.json(
        { error: `The proof store responded ${upstream.status}.${hint}` },
        { status: 502 }
      );
    }

    // Pipe the image through. `private, no-store` keeps it out of shared
    // caches; the bytes are the counterparty's to see, but the URL stays ours.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
        "cache-control": "private, no-store",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
      },
    });
  }

  // Proofs stored before assets were private. That URL is public, so this is a
  // redirect to exactly what the client used to store - kept so old payments
  // don't lose their proof. Deliberately not proxied: fetching an arbitrary
  // stored URL server-side would hand anyone who can write that column a way to
  // make the server fetch things on their behalf.
  if (payment.proofUrl) {
    return NextResponse.redirect(payment.proofUrl, {
      status: 302,
      headers: { "cache-control": "no-store" },
    });
  }

  return NextResponse.json({ error: "This payment has no proof" }, { status: 404 });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
