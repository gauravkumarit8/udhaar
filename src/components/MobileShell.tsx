"use client";

import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import OfflineBanner from "@/components/OfflineBanner";
import BottomNav from "@/components/BottomNav";
import { useStatusBar, useSplashScreen, useIsNative } from "@/hooks/useNative";
import { cx } from "@/components/ui";

interface MobileShellProps {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  /** Show a back chevron. `true` goes back in history; a string is a href. */
  back?: boolean | string;
  /** Drop the header entirely: the screen prints its own (home does). */
  bare?: boolean;
  showNav?: boolean;
  rightAction?: React.ReactNode;
  /** Removes the horizontal padding, for screens that manage their own. */
  bleed?: boolean;
  className?: string;
}

/**
 * The frame every screen sits in.
 *
 * It owns three things so no page has to remember them: the header, the tab
 * bar, and the space the tab bar takes up. The install prompt lives here too,
 * because it is a property of the app rather than of any screen - and it now
 * waits until the person has actually done something, instead of appearing
 * over a dashboard they are still reading.
 */
export default function MobileShell({
  children,
  title,
  subtitle,
  back,
  bare = false,
  showNav = true,
  rightAction,
  bleed = false,
  className,
}: MobileShellProps) {
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const isNativeApp = useIsNative();
  const [isInstalled] = useState(
    () =>
      isNativeApp ||
      (typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches)
  );

  useStatusBar();
  useSplashScreen();

  useEffect(() => {
    if (!isNativeApp && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    // Twelve seconds and one navigation's worth of use, rather than five
    // seconds and a chance of landing mid-read.
    if (!isInstalled && !isNativeApp) {
      const timer = setTimeout(() => setShowInstallBanner(true), 12_000);
      return () => clearTimeout(timer);
    }
  }, [isNativeApp, isInstalled]);

  const goBack = () => {
    if (typeof back === "string") {
      window.location.assign(back);
      return;
    }
    if (window.history.length > 1) window.history.back();
    else window.location.assign("/dashboard");
  };

  return (
    <div className={cx("relative mx-auto flex min-h-screen w-full max-w-lg flex-col", className)}>
      <OfflineBanner />

      {!bare && (
      <header
        className={cx(
          "safe-top sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur-xl"
        )}
      >
        <div className="flex h-14 items-center gap-2 px-3">
          {back !== undefined && back !== false && (
            <button
              onClick={goBack}
              aria-label="Go back"
              className="tap -ml-1 flex size-9 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2"
            >
              <ChevronLeft className="size-6" />
            </button>
          )}

          <div className={cx("min-w-0 flex-1", back === undefined || back === false ? "pl-1" : "")}>
            {title && (
              <h1 className="truncate text-[17px] font-bold tracking-tight text-ink">{title}</h1>
            )}
            {subtitle && <p className="truncate text-[12px] font-medium text-ink-3">{subtitle}</p>}
          </div>

          {rightAction}
        </div>
      </header>
      )}

      <main
        className={cx(
          "flex-1",
          // Reserve the tab bar's height only when the tab bar is there. Written
          // as one class per case rather than two stacked ones, because two
          // `pb-*` utilities resolve by stylesheet order, not by the order they
          // are written here - which is how a screen with no nav ends up with
          // the nav's padding.
          bleed ? "" : "px-4",
          showNav ? "pb-24" : "pb-8"
        )}
      >
        {children}
      </main>

      {showInstallBanner && !isInstalled && (
        <div className="animate-rise fixed inset-x-0 bottom-[74px] z-30 px-4">
          <div className="mx-auto flex max-w-lg items-center gap-3 rounded-card border border-line bg-surface p-3 shadow-float">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-brand-soft text-lg">
              💰
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-ink">Keep Udhaar on your phone</p>
              <p className="text-[11px] text-ink-3">
                Add it to your home screen - opens like an app, works offline
              </p>
            </div>
            <button
              onClick={() => setShowInstallBanner(false)}
              className="tap shrink-0 rounded-control px-3 py-2 text-[12px] font-semibold text-ink-3 hover:bg-surface-2"
            >
              Later
            </button>
          </div>
        </div>
      )}

      {isNativeApp && (
        <div className="safe-top fixed right-3 z-40 rounded-b-lg bg-brand px-2 py-0.5 text-[9px] font-bold text-brand-ink">
          NATIVE
        </div>
      )}

      {showNav && <BottomNav />}
    </div>
  );
}

/**
 * The skeleton shape of a list screen, so a load never shows a blank page.
 * Shared because every list in the app should breathe at the same rate.
 */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 py-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-card border border-line bg-surface p-4"
        >
          <div className="skeleton size-11 rounded-2xl" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3.5 w-1/3 rounded-full" />
            <div className="skeleton h-3 w-1/2 rounded-full" />
          </div>
          <div className="skeleton h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}
