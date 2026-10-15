"use client";

import { WifiOff } from "lucide-react";
import { useNetworkStatus } from "@/hooks/useNative";

/**
 * Says the obvious thing once, at the top, without taking the screen over.
 * Everything already read stays readable offline - this is about the actions
 * that will not go through, so it is a strip rather than a page.
 */
export default function OfflineBanner() {
  const online = useNetworkStatus();

  if (online) return null;

  return (
    <div
      role="status"
      className="safe-top fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 bg-warn px-4 py-2 text-[12px] font-semibold text-white animate-rise"
    >
      <WifiOff className="size-3.5" />
      You&apos;re offline - changes you make now won&apos;t be saved
    </div>
  );
}
