import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Udhaar — Track Loans & EMIs",
  description: "Splitwise + EMI Tracker + Auto Reminder for informal loans in India",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Udhaar",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  /*
   * The colour the phone paints its own chrome with. It follows the app's own
   * tokens - the brand emerald in light, the lighter one used on dark surfaces
   * in dark - so the status bar is never a brighter green than everything
   * below it. Values are the sRGB equivalents of --brand in globals.css.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#00855b" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className="min-h-screen bg-bg text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
