import { v2 as cloudinary } from "cloudinary";

let configured = false;

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

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  configured = true;
}

// Reject absurdly large uploads before they ever hit the network -
// payment proof photos have no business being bigger than this.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB

/**
 * Uploads a base64 data URL (e.g. "data:image/jpeg;base64,...") to Cloudinary
 * and returns the hosted, permanent URL. Never store the raw data URL in the
 * database - that bloats Postgres fast and kills query/backup performance.
 */
export async function uploadProofImage(dataUrl: string, folder = "udhaar/proofs"): Promise<string> {
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
    // Keep costs/storage predictable - proof photos don't need to be huge
    transformation: [{ width: 1600, height: 1600, crop: "limit", quality: "auto:good" }],
  });

  return result.secure_url;
}
