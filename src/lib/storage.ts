import { v2 as cloudinary } from "cloudinary";

/**
 * Payment-proof storage.
 *
 * Proofs are bank/UPI screenshots — they carry names, amounts and sometimes
 * account details — so they are stored **privately**: uploaded to Cloudinary as
 * `type: authenticated`, which makes them impossible to fetch without a
 * signature, and handed out only by `GET /api/payments/[id]/proof`, which
 * checks that the caller is actually party to the loan before minting a
 * short-lived signed URL.
 *
 * The database therefore stores the asset's *public id*, never a fetchable URL.
 */
let configured = false;

/** Whether proofs can be stored and served at all. */
export function isStorageConfigured(): boolean {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );
}

function ensureConfigured() {
  if (configured) return;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET " +
        "(free tier at https://cloudinary.com/users/register/free)."
    );
  }

  // Optional: accounts that serve assets from their own domain (or a proxy) can
  // point delivery at it. Unset is the normal case.
  const deliveryHost = process.env.CLOUDINARY_DELIVERY_HOST;

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
    ...(deliveryHost
      ? { private_cdn: true, secure_distribution: deliveryHost }
      : {}),
  });

  configured = true;
}

// Reject absurdly large uploads before they ever hit the network -
// payment proof photos have no business being bigger than this.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB

const FOLDER = "udhaar/proofs";

/**
 * Uploads a base64 data URL (e.g. "data:image/jpeg;base64,...") privately and
 * returns the asset's id, e.g. `udhaar/proofs/abc123.jpg`.
 *
 * Never store the raw data URL in the database - that bloats Postgres fast and
 * kills query/backup performance.
 */
export async function uploadProofImage(dataUrl: string, folder = FOLDER): Promise<string> {
  if (!dataUrl.startsWith("data:image/")) {
    throw new Error("Expected a base64 image data URL");
  }

  // Rough size check: base64 is ~4/3 the size of the raw bytes
  const approxBytes = (dataUrl.length * 3) / 4;
  if (approxBytes > MAX_UPLOAD_BYTES) {
    throw new Error("Image is too large (max 8MB)");
  }

  ensureConfigured();

  const result = await cloudinary.uploader.upload(dataUrl, {
    folder,
    resource_type: "image",
    // The whole point: not publicly fetchable. Cloudinary only serves it with a
    // signature, and signed URLs expire.
    type: "authenticated",
    // Keep costs/storage predictable - proof photos don't need to be huge
    transformation: [{ width: 1600, height: 1600, crop: "limit", quality: "auto:good" }],
  });

  // The extension is part of the id, so `cloudinary.url()` derives the format.
  return result.format ? `${result.public_id}.${result.format}` : result.public_id;
}

/**
 * Builds the signed delivery URL for an authenticated asset.
 *
 * This URL is **server-side only** - the proof route uses it to fetch the
 * bytes and streams them to the authorised user. It is never returned to a
 * client, which is why it does not need an expiry of its own: the only party
 * that can build it is the one holding the API secret, and the only thing a
 * browser ever sees is `/api/payments/[id]/proof`.
 *
 * Throws when Cloudinary is not configured - the caller turns that into a 503
 * that names the missing environment variables rather than a broken image.
 */
export function signedDeliveryUrl(proofPublicId: string): string {
  ensureConfigured();

  return cloudinary.url(proofPublicId, {
    type: "authenticated",
    sign_url: true,
    secure: true,
    // No analytics tag: it is noise in a URL that should carry nothing but
    // the signature.
    analytics: false,
  });
}
