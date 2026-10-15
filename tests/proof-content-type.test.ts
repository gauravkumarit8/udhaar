import { describe, expect, it } from "vitest";
import {
  PROOF_FALLBACK_CONTENT_TYPE,
  PROOF_RESPONSE_CSP,
  safeProofContentType,
} from "@/lib/proof-content-type";

/**
 * What the app declares for bytes it is only relaying.
 *
 * The stored XSS this closes: the proof route used to pass Cloudinary's own
 * content type through, so an uploaded SVG came back as `image/svg+xml` from the
 * app's origin and the browser ran its script. `nosniff` is no defence against a
 * type the server declares itself, so the type is chosen here instead.
 */
describe("safeProofContentType", () => {
  it("keeps the raster types the app accepts", () => {
    expect(safeProofContentType("image/jpeg")).toBe("image/jpeg");
    expect(safeProofContentType("image/png")).toBe("image/png");
    expect(safeProofContentType("image/webp")).toBe("image/webp");
    expect(safeProofContentType("image/heic")).toBe("image/heic");
    expect(safeProofContentType("image/avif")).toBe("image/avif");
  });

  it("normalises case and drops parameters", () => {
    expect(safeProofContentType("IMAGE/PNG")).toBe("image/png");
    expect(safeProofContentType("image/jpeg; charset=binary")).toBe("image/jpeg");
  });

  it("never passes an active document type through", () => {
    // The attack, and the neighbours of it.
    expect(safeProofContentType("image/svg+xml")).toBe(PROOF_FALLBACK_CONTENT_TYPE);
    expect(safeProofContentType("text/html")).toBe(PROOF_FALLBACK_CONTENT_TYPE);
    expect(safeProofContentType("application/xhtml+xml")).toBe(PROOF_FALLBACK_CONTENT_TYPE);
    expect(safeProofContentType("application/pdf")).toBe(PROOF_FALLBACK_CONTENT_TYPE);
    expect(safeProofContentType("application/javascript")).toBe(PROOF_FALLBACK_CONTENT_TYPE);
    expect(safeProofContentType("")).toBe(PROOF_FALLBACK_CONTENT_TYPE);
    expect(safeProofContentType(null)).toBe(PROOF_FALLBACK_CONTENT_TYPE);
    expect(safeProofContentType(undefined)).toBe(PROOF_FALLBACK_CONTENT_TYPE);
  });

  it("cannot be talked into a type by a crafted value", () => {
    // Values that try to look like an allowlisted one.
    expect(safeProofContentType("image/jpeg, text/html")).toBe(PROOF_FALLBACK_CONTENT_TYPE);
    expect(safeProofContentType(" image/jpeg\nX-Injected: 1")).toBe(PROOF_FALLBACK_CONTENT_TYPE);
    expect(safeProofContentType("image/svg+xml;base64")).toBe(PROOF_FALLBACK_CONTENT_TYPE);
  });
});

describe("the proof response policy", () => {
  it("loads nothing and runs sandboxed", () => {
    expect(PROOF_RESPONSE_CSP).toContain("default-src 'none'");
    expect(PROOF_RESPONSE_CSP).toContain("sandbox");
    // A sandbox that kept the origin would not help: the payload could still
    // reach the session's same-origin APIs.
    expect(PROOF_RESPONSE_CSP).not.toContain("allow-same-origin");
  });
});
