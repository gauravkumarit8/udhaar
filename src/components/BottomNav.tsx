"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useHaptics } from "@/hooks/useNative";
import { Home, HandCoins, Plus, Bell, User, type LucideIcon } from "lucide-react";
import {
  isUnreadFresh,
  readUnreadAt,
  UNREAD_AT_KEY,
  UNREAD_CACHE_KEY,
  UNREAD_EVENT,
} from "@/lib/client-cache";
import { cx } from "@/components/ui";

/**
 * Five destinations, one of them the thing people actually came to do.
 *
 * The bar is the app's only navigation. Loans got its own tab because "where
 * is that loan" was a two-tap question (Home → see all) for the thing people
 * look at most, and because a list is somewhere you go, not somewhere you
 * land. The centre is a raised add button, which is one tap from anywhere in
 * the app - the same number of taps as before, without taking a tab slot.
 */

/**
 * The Activity tab's badge: how many notifications arrived since this person
 * last opened that screen.
 *
 * Without it, a notification was only discoverable by going to the Activity
 * screen and looking - which is why "I can't see the notification" was a
 * reasonable thing to say even when one existed. The count lives on the
 * server (users.notifications_seen_at), so it is the same on every device.
 */
/** The last count this device saw, so the badge paints before the request returns. */
function rememberUnread(count: number): void {
  try {
    sessionStorage.setItem(UNREAD_CACHE_KEY, String(count));
    sessionStorage.setItem(UNREAD_AT_KEY, String(Date.now()));
  } catch {
    // Private mode, storage full - the badge just isn't pre-painted.
  }
}

function useUnreadCount(): number {
  // Starts from what this device last saw: a badge that appears instantly and
  // corrects itself a moment later beats a badge that appears late. The tab bar
  // is on every screen and remounts on each navigation, so without this the
  // count flickered away and back every time somebody changed tabs.
  const [unread, setUnread] = useState(() => {
    if (typeof window === "undefined") return 0;
    try {
      const cached = Number(sessionStorage.getItem(UNREAD_CACHE_KEY));
      return Number.isFinite(cached) && cached > 0 ? cached : 0;
    } catch {
      return 0;
    }
  });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch("/api/notifications?summary=1", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const count = typeof data?.unread === "number" ? data.unread : 0;
        setUnread(count);
        rememberUnread(count);
      } catch {
        // Offline or logged out - leave the last known count alone.
      }
    };

    // A page that was answered in the last half-minute has already told us the
    // count; only ask if what we have is older than that.
    if (!isUnreadFresh(readUnreadAt())) void load();

    const timer = setInterval(load, 60_000);
    const onFocus = () => void load();

    // Another screen's own response carried the count: use it, and treat it as
    // freshly confirmed so the poll above does not immediately repeat it.
    const onPublished = (event: Event) => {
      const detail = (event as CustomEvent<number>).detail;
      if (typeof detail !== "number" || cancelled) return;
      setUnread(detail);
      rememberUnread(detail);
    };
    window.addEventListener(UNREAD_EVENT, onPublished);
    // Opening the Activity screen clears the badge immediately instead of
    // waiting for the next poll.
    const onSeen = () => {
      setUnread(0);
      rememberUnread(0);
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("udhaar:notifications-seen", onSeen);

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("udhaar:notifications-seen", onSeen);
      window.removeEventListener(UNREAD_EVENT, onPublished);
    };
  }, []);

  return unread;
}

interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Also counts as active for these paths. */
  matches?: string[];
  badge?: number;
}

export default function BottomNav() {
  const pathname = usePathname();
  const haptics = useHaptics();
  const unread = useUnreadCount();

  const tabs: Tab[] = [
    { href: "/dashboard", label: "Home", icon: Home, matches: ["/"] },
    { href: "/loans", label: "Loans", icon: HandCoins },
    { href: "/loans/new", label: "Add", icon: Plus },
    { href: "/activity", label: "Activity", icon: Bell, badge: unread },
    { href: "/profile", label: "You", icon: User },
  ];

  return (
    <nav
      aria-label="Main"
      className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/85 backdrop-blur-xl"
    >
      <div className="mx-auto flex h-[58px] w-full max-w-lg items-stretch">
        {tabs.map((tab) => {
          const isAdd = tab.href === "/loans/new";
          const isActive = isAdd
            ? pathname === "/loans/new"
            : [tab.href, ...(tab.matches ?? [])].some(
                (href) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`))
              ) ||
              // /loans must not light up while adding one.
              (tab.href === "/loans" && pathname === "/loans");

          const Icon = tab.icon;

          return (
            <a
              key={tab.href}
              href={tab.href}
              onClick={() => haptics.tap()}
              aria-current={isActive ? "page" : undefined}
              className={cx(
                "tap relative flex flex-1 flex-col items-center justify-center gap-1",
                isActive ? "text-brand" : "text-ink-3 hover:text-ink-2"
              )}
            >
              {isAdd ? (
                <span
                  className={cx(
                    "flex size-11 items-center justify-center rounded-2xl bg-brand text-brand-ink",
                    "shadow-[0_6px_18px_-6px_var(--brand)]",
                    isActive && "ring-4 ring-[var(--ring)]"
                  )}
                >
                  <Icon className="size-6" strokeWidth={2.6} />
                </span>
              ) : (
                <span className="relative">
                  <Icon className="size-[22px]" strokeWidth={isActive ? 2.4 : 2} />
                  {tab.badge !== undefined && tab.badge > 0 && (
                    <span
                      aria-label={`${tab.badge} unread notification${tab.badge === 1 ? "" : "s"}`}
                      className="absolute -top-1.5 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] font-bold text-white"
                    >
                      {tab.badge > 9 ? "9+" : tab.badge}
                    </span>
                  )}
                </span>
              )}
              <span
                className={cx(
                  "text-[10px] font-semibold tracking-tight",
                  isAdd ? "-mt-0.5" : ""
                )}
              >
                {tab.label}
              </span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
