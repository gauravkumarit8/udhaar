"use client";

import { useNetworkStatus } from "@/hooks/useNative";

export default function OfflineBanner() {
  const online = useNetworkStatus();

  if (online) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] bg-red-600 text-white text-center py-2 text-xs font-semibold safe-area-top animate-slide-down">
      📡 You&apos;re offline — some features may not work
    </div>
  );
}
