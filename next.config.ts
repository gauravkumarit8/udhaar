import type { NextConfig } from "next";

/*
 * Security headers.
 *
 * Before this the app sent exactly one relevant header - `X-Powered-By:
 * Next.js` - over HTTPS to a money app. That meant: no framing protection (the
 * login and payment screens could be clickjacked inside someone else's page),
 * no `nosniff` on JSON or on the payment-proof route, no referrer policy, no
 * HSTS, and no CSP at all while the app was serving user-uploaded bytes from
 * its own origin.
 *
 * Two things are deliberate:
 *
 *   - `script-src` keeps `'unsafe-inline'` (Next's own bootstrap is inline) and
 *     does *not* include `'unsafe-eval'` - the production client bundle has no
 *     `eval(` in it, which was checked rather than assumed. Moving to a
 *     nonce-based policy is the next step up; this one already blocks the
 *     exfiltration half of an XSS (`connect-src 'self'`) and every frame,
 *     object and base-tag route.
 *   - `frame-ancestors` is `'none'` unless `FRAME_ANCESTORS` says otherwise.
 *     That default is right for the product (nobody should be able to frame
 *     Udhaar), and the variable exists so a *preview* environment that embeds
 *     the app in a frame can say so instead of being broken by it.
 */
const isDev = process.env.NODE_ENV !== "production";

const frameAncestors = process.env.FRAME_ANCESTORS?.trim() || "'none'";

/*
 * The CSP, minus framing rules (they vary by environment).
 *
 * `img-src` allows `data:` and `blob:` because proof screenshots are previewed
 * locally before upload, and `https://res.cloudinary.com` because a proof
 * stored before assets were private is served as a redirect there.
 * `worker-src` allows `blob:` for the service worker's own chunk.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https://res.cloudinary.com",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  `frame-ancestors ${frameAncestors}`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  // Two years, subdomains included: this app is HTTPS-only and stays that way.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // Browsers that ignore frame-ancestors still honour this one. Only sent when
  // framing is actually denied, because the header cannot express an exception.
  ...(frameAncestors === "'none'" ? [{ key: "X-Frame-Options", value: "DENY" }] : []),
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(), payment=()",
  },
  // API responses and static assets are for this app, not for other sites to
  // embed or hotlink.
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Standalone output for Docker / containerized deployments.
  // Also works fine for regular `npm run build` + `npm run start`.
  output: "standalone",
  images: {
    unoptimized: true,
  },
  // Announcing the framework (and its version) to every caller is a gift to
  // nobody but whoever is looking for a known CVE.
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Everything, including the API and the proof route - a JSON error
        // body deserves nosniff just as much as an image does.
        source: "/(.*)",
        headers: securityHeaders,
      },
      {
        // The service worker must never be served stale, or a device can be
        // pinned to an old app shell after a deploy.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
