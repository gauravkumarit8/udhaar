"use client";

import { useEffect, useState } from "react";
import OfflineBanner from "@/components/OfflineBanner";
import { useStatusBar, useSplashScreen, useIsNative } from "@/hooks/useNative";

interface MobileShellProps {
  children: React.ReactNode;
  title?: string;
  showNav?: boolean;
  transparentHeader?: boolean;
  rightAction?: React.ReactNode;
}

export default function MobileShell({
  children,
  title,
  showNav = true,
  transparentHeader = false,
  rightAction,
}: MobileShellProps) {
  const [isInstalled, setIsInstalled] = useState(false);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const isNativeApp = useIsNative();

  // Native features
  useStatusBar();
  useSplashScreen();

  useEffect(() => {
    // Register service worker (web only)
    if (!isNativeApp && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    // Check if installed (PWA)
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
    setIsInstalled(isStandalone || isNativeApp);

    // Show install banner after 5 seconds if not installed and not native
    if (!isStandalone && !isNativeApp) {
      const timer = setTimeout(() => setShowInstallBanner(true), 5000);
      return () => clearTimeout(timer);
    }
  }, [isNativeApp]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col max-w-lg mx-auto relative">
      {/* Offline Banner */}
      <OfflineBanner />

      {/* Status bar spacer */}
      <div className="h-[env(safe-area-inset-top)]" />

      {/* Header */}
      {title && (
        <header
          className={`sticky top-0 z-40 flex items-center justify-between px-4 h-14 ${
            transparentHeader
              ? "bg-transparent"
              : "bg-white/90 backdrop-blur-xl border-b border-slate-100"
          }`}
        >
          <h1 className="text-lg font-bold text-slate-800">{title}</h1>
          {rightAction}
        </header>
      )}

      {/* Content */}
      <main className="flex-1 pb-28">{children}</main>

      {/* Bottom Nav spacer */}
      {showNav && <div className="h-[env(safe-area-inset-bottom)]" />}

      {/* Install Banner — only for web PWA */}
      {showInstallBanner && !isInstalled && (
        <div className="fixed bottom-20 left-4 right-4 max-w-lg mx-auto bg-emerald-700 text-white rounded-2xl p-4 shadow-2xl z-40 animate-slide-up">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-xl shrink-0">
              💰
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm">Install Udhaar App</p>
              <p className="text-emerald-200 text-xs">Add to home screen for the best experience</p>
            </div>
            <button
              onClick={() => setShowInstallBanner(false)}
              className="text-emerald-300 text-xs shrink-0"
            >
              Later
            </button>
          </div>
        </div>
      )}

      {/* Native badge */}
      {isNativeApp && (
        <div className="fixed top-[env(safe-area-inset-top)] right-4 z-[60] bg-emerald-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-b-lg">
          NATIVE
        </div>
      )}
    </div>
  );
}
