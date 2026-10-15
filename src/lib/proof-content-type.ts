/**
 * What content type the app will *declare* for bytes it did not create.
 *
 * A payment proof comes back from Cloudinary, and this app used to pass
 * Cloudinary's own `content-type` straight through to the browser. That is how
 * an uploaded SVG - markup the browser parses and runs - could be served from
 * the app's own origin: the response said `image/svg+xml`, so the browser
 * rendered it as a document, and `X-Content-Type-Options: nosniff` does nothing
 * about a type the server declared itself.
 *
 * So the declared type is now chosen from an allowlist of raster formats, and
 * anything else (SVG included, whether it slipped in before the upload gate
 * existed or Cloudinary does something clever) is served as a JPEG that will
 * simply fail to decode - a broken image beats a script running as the user.
 */

export const SAFE_PROOF_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
] as const;

export const PROOF_FALLBACK_CONTENT_TYPE = "image/jpeg";

/**
 * The CSP on a proof response: the document is not allowed to load anything,
 * and it runs in a sandbox with a unique origin, so even active content cannot
 * reach the app's origin, its storage or its session.
 */
export const PROOF_RESPONSE_CSP = "default-src 'none'; sandbox";

/** Pick a safe declared type for upstream bytes; never echo an unsafe one. */
export function safeProofContentType(upstream: string | null | undefined): string {
  if (!upstream) return PROOF_FALLBACK_CONTENT_TYPE;

  // Strip any parameters (`image/jpeg; charset=…`) and normalise case.
  const bare = upstream.split(";")[0].trim().toLowerCase();
  return (SAFE_PROOF_CONTENT_TYPES as readonly string[]).includes(bare)
    ? bare
    : PROOF_FALLBACK_CONTENT_TYPE;
}
