/**
 * What actually arrived in an upload.
 *
 * Payment proofs are bank/UPI screenshots, so the only thing that belongs here
 * is a raster photo. Two checks, because either alone is bypassable:
 *
 *   1. The declared type in the data URL must be a raster image. `image/svg+xml`
 *      is *not* one, however much it looks like one: an SVG is a document the
 *      browser will happily parse and run script in, and this app serves proofs
 *      back from its own origin (see the CSP on that response too).
 *   2. The bytes must start with a real image signature. SVG has no signature
 *      at all, so a caller that labels `<svg><script>…` as `image/png` fails
 *      here - and so does a PDF, an HTML page, or a zip file wearing an image
 *      mime type.
 *
 * Pure functions, no Cloudinary, no database: the edge cases are the whole
 * product here, so they are unit-tested (tests/image-type.test.ts).
 */

export type RasterImageType = "jpeg" | "png" | "gif" | "webp" | "heic" | "avif";

/** The mime types a proof may declare, and the sniffed type each must match. */
const DECLARED_TYPES: Record<string, RasterImageType[]> = {
  "image/jpeg": ["jpeg"],
  "image/jpg": ["jpeg"],
  "image/png": ["png"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/heic": ["heic"],
  "image/heif": ["heic"],
  "image/avif": ["avif"],
};

export interface ParsedDataUrl {
  mime: string;
  /** The base64 payload, still encoded. */
  base64: string;
}

/**
 * Split `data:<mime>;base64,<payload>`.
 *
 * Deliberately strict: no charset parameters, no whitespace, base64 only (a
 * plain-text data URL would let a caller smuggle arbitrary markup past the
 * signature check below).
 */
export function parseDataUrl(dataUrl: string): ParsedDataUrl | null {
  if (typeof dataUrl !== "string") return null;

  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match) return null;

  return { mime: match[1].toLowerCase(), base64: match[2] };
}

/** Decode the first `maxBytes` bytes of a base64 string (enough for a signature). */
function decodePrefix(base64: string, maxBytes: number): Uint8Array | null {
  // 4 base64 characters produce 3 bytes; round up to a multiple of 4.
  const needed = Math.ceil(maxBytes / 3) * 4;
  const slice = base64.slice(0, needed);
  if (slice.length < 4) return null;

  try {
    // Node and the browser both have atob-compatible decoding; Buffer is the
    // server-side one. Either can throw on malformed input - that is a reject.
    const buffer =
      typeof Buffer !== "undefined"
        ? Buffer.from(slice, "base64")
        : Uint8Array.from(atob(slice), (ch) => ch.charCodeAt(0));
    const bytes = new Uint8Array(buffer);
    return bytes.length === 0 ? null : bytes;
  } catch {
    return null;
  }
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
  signature.every((byte, index) => bytes[offset + index] === byte);

/** The `ftyp` brand, for the ISO-BMFF family (HEIC/HEIF and AVIF). */
function isoBrand(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") return null;
  return String.fromCharCode(...bytes.subarray(8, 12));
}

const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"];

/**
 * The image format the bytes actually are, or null when they are not an image
 * this app accepts. Signatures, not extensions: an SVG, an HTML page or a zip
 * file all return null no matter what they claim to be.
 */
export function sniffImageType(bytes: Uint8Array): RasterImageType | null {
  if (bytes.length < 12) return null;

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif"; // GIF8(7a|9a)
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && // RIFF
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "webp";
  }

  const brand = isoBrand(bytes);
  if (brand === "avif" || brand === "avis") return "avif";
  if (brand && HEIC_BRANDS.includes(brand)) return "heic";

  return null;
}

export type ProofImageCheck =
  | { ok: true; type: RasterImageType; declaredMime: string }
  | { ok: false; error: string };

/**
 * The gate an uploaded proof has to pass: declared type *and* real bytes.
 *
 * Both must agree, so a caller cannot pass a JPEG off as a PNG either. The
 * errors are written for a person who just uploaded their screenshot, not for
 * a security log.
 */
export function checkProofImage(dataUrl: string): ProofImageCheck {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    return {
      ok: false,
      error: "Expected an image uploaded as a base64 data URL (data:image/...;base64,...).",
    };
  }

  const allowed = DECLARED_TYPES[parsed.mime];
  if (!allowed) {
    // Naming SVG explicitly: it is the one type that looks like an image and
    // is not, and "why can't I upload this icon?" deserves an answer.
    const hint =
      parsed.mime === "image/svg+xml"
        ? " An SVG is a document that can run code, not a photo - save it as a PNG or JPEG first."
        : "";
    return {
      ok: false,
      error: `Proofs must be a JPEG, PNG, GIF, WebP, HEIC or AVIF image (got ${parsed.mime}).${hint}`,
    };
  }

  const prefix = decodePrefix(parsed.base64, 16);
  const sniffed = prefix ? sniffImageType(prefix) : null;

  if (!sniffed || !allowed.includes(sniffed)) {
    return {
      ok: false,
      error:
        "That file doesn't look like the image it says it is - the bytes don't match any supported photo format.",
    };
  }

  return { ok: true, type: sniffed, declaredMime: parsed.mime };
}
