"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  BellRing,
  ChevronRight,
  Download,
  HandCoins,
  LogOut,
  MessageSquare,
  Smartphone,
  Star,
  Trash2,
} from "lucide-react";
import MobileShell from "@/components/MobileShell";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Notice,
  SectionHeader,
  cx,
} from "@/components/ui";
import { requestJson } from "@/lib/http";
import { clearClientCaches } from "@/lib/client-cache";
import {
  browserPushState,
  disableBrowserPush,
  enableBrowserPush,
  type BrowserPushState,
} from "@/lib/webpush-client";

interface User {
  id: string;
  name: string;
  mobile: string;
  pushEnabled: boolean;
}

interface Channels {
  push: boolean;
  sms: boolean;
  whatsapp: boolean;
}

/**
 * You, and everything about your account.
 *
 * The switches are real - the push one writes a preference the server checks
 * before it sends anything, and also subscribes or unsubscribes *this* browser,
 * because a switch that claims to have done something it hasn't is the kind of
 * lie this screen used to tell. Your own data is one tap away, and the two
 * irreversible things (delete, log out) are at the bottom, in that order.
 */
export default function ProfilePage() {
  const [user, setUser] = useState<User | null>(null);
  const [channels, setChannels] = useState<Channels>({ push: true, sms: false, whatsapp: false });
  const [loading, setLoading] = useState(true);
  const [savingPush, setSavingPush] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const result = await requestJson<{ profile: User; channels: Channels }>("/api/profile");
      if (result.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (result.ok && result.data) {
        setUser(result.data.profile);
        setChannels(result.data.channels);
      }
      setLoading(false);
    })();
  }, []);

  // Whether *this* browser can receive notifications right now.
  const [browserPush, setBrowserPush] = useState<BrowserPushState | null>(null);
  const [pushNote, setPushNote] = useState<string | null>(null);

  useEffect(() => {
    void browserPushState().then(setBrowserPush);
  }, []);

  // The push switch is a real preference: sendPushToUser checks it before
  // touching any channel. It previously toggled local component state and
  // nothing else.
  //
  // Turning it on also subscribes *this* browser, and turning it off
  // unsubscribes it - otherwise the switch would claim something it hadn't
  // done, which is exactly the kind of lie this screen used to tell.
  const togglePush = async () => {
    if (!user || savingPush) return;
    const next = !user.pushEnabled;
    setUser({ ...user, pushEnabled: next });
    setSavingPush(true);
    setPushNote(null);

    try {
      if (next && (browserPush === "default" || browserPush === "granted-unsubscribed")) {
        const result = await enableBrowserPush();
        if (result.ok) {
          setBrowserPush("granted-subscribed");
        } else {
          setPushNote(result.reason);
          if (result.reason.includes("blocked")) setBrowserPush("denied");
        }
      } else if (!next && browserPush === "granted-subscribed") {
        await disableBrowserPush();
        setBrowserPush("granted-unsubscribed");
      }

      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pushEnabled: next }),
      });
      if (!res.ok) setUser({ ...user, pushEnabled: !next });
    } catch {
      setUser({ ...user, pushEnabled: !next });
    } finally {
      setSavingPush(false);
    }
  };

  /** Downloads everything the app holds about this person, as a JSON file. */
  const handleExport = () => {
    // A plain navigation, not fetch: the route sets Content-Disposition, and
    // letting the browser handle it avoids holding the whole file in memory.
    window.location.href = "/api/account/export";
  };

  /**
   * Deleting is offered honestly: the server refuses while a loan is open, and
   * that refusal is a feature (a loan belongs to two people). So the UI asks
   * once, then shows exactly what the server said if it says no.
   */
  const handleDelete = async () => {
    if (
      !confirm(
        "Delete your account?\n\n" +
          "This removes your profile and every loan you are on, including its payments and " +
          "history. The other person on a closed loan loses that record too.\n\n" +
          "It cannot be undone."
      )
    ) {
      return;
    }

    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/account", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!res.ok) {
        setDeleteError(data.action || data.error || "Couldn't delete the account. Try again.");
        return;
      }

      // The session is gone with the account - back to the front door.
      window.location.assign("/login");
    } catch {
      setDeleteError("Network error - nothing was deleted.");
    } finally {
      setDeleting(false);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    // Whatever this device was showing belongs to the person leaving.
    clearClientCaches();
    window.location.assign("/login");
  };

  const pushHint =
    browserPush === "granted-subscribed"
      ? "this device is registered"
      : browserPush === "denied"
        ? "blocked in your browser settings"
        : browserPush === "not-configured"
          ? "the server has no notification keys yet"
          : browserPush === "unsupported"
            ? "this browser can't show notifications"
            : undefined;

  return (
    <MobileShell title="You">
      <div className="px-4 pb-8 pt-3">
        <Card padded={false} className="overflow-hidden bg-brand text-brand-ink">
          <div className="flex items-center gap-4 px-5 py-5">
            <Avatar name={user?.name || "?"} size={56} className="bg-black/15 text-brand-ink" />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[20px] font-bold tracking-tight">
                {loading ? "…" : user?.name || "You"}
              </h2>
              <p className="text-[13px] opacity-80">+91 {user?.mobile || "-"}</p>
            </div>
            <Badge className="bg-black/15 text-brand-ink">
              <span className="size-1.5 rounded-full bg-current" />
              {user?.pushEnabled ? "notifications on" : "notifications off"}
            </Badge>
          </div>
        </Card>

        <SectionHeader title="Notifications" className="mt-6" />
        <Card padded={false} className="divide-y divide-line">
          <button
            type="button"
            onClick={togglePush}
            disabled={savingPush || !user}
            aria-pressed={user?.pushEnabled ?? false}
            className="tap flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-2 disabled:opacity-60"
          >
            <span className="flex size-10 items-center justify-center rounded-control bg-surface-2 text-ink-2">
              <Smartphone className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-ink">Push notifications</span>
              <span className="block text-[11px] text-ink-3">
                {pushHint ?? "Told the moment a payment is marked or confirmed"}
              </span>
            </span>
            <Switch on={user?.pushEnabled ?? false} busy={savingPush} />
          </button>

          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex size-10 items-center justify-center rounded-control bg-surface-2 text-ink-2">
              <MessageSquare className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-ink">WhatsApp reminders</span>
              <span className="block text-[11px] leading-snug text-ink-3">
                Sent from your own WhatsApp, so the borrower needs nothing installed
              </span>
            </span>
          </div>

          {pushNote && (
            <div className="px-4 py-3.5">
              <Notice tone="warn">{pushNote}</Notice>
            </div>
          )}

          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex size-10 items-center justify-center rounded-control bg-surface-2 text-ink-2">
              <BellRing className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-ink">Automatic SMS</span>
              <span className="block text-[11px] leading-snug text-ink-3">
                {channels.sms
                  ? "MSG91 is configured - OTPs are sent for real."
                  : "Not set up: SMS is only used for OTPs once MSG91 keys are added. Reminders go through your own phone."}
              </span>
            </span>
          </div>
        </Card>

        <SectionHeader title="Reminders" className="mt-6" />
        <Card>
          <p className="text-[13px] leading-relaxed text-ink-2">
            Udhaar nudges the borrower 2 days before, 1 day before and on the due date, then daily
            while it stays unpaid. From any payment you can also send one on WhatsApp or by SMS, or
            as an in-app notification if the borrower installed Udhaar.
          </p>
          <div className="mt-3 grid grid-cols-4 gap-2">
            {["T-2", "T-1", "T0", "7d"].map((tag) => (
              <span
                key={tag}
                className="rounded-control bg-surface-2 py-1.5 text-center text-[11px] font-bold text-ink-2"
              >
                {tag}
              </span>
            ))}
          </div>
        </Card>

        <SectionHeader title="Your data" className="mt-6" />
        <Card padded={false} className="divide-y divide-line">
          <button
            onClick={handleExport}
            className="tap flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-2"
          >
            <span className="flex size-10 items-center justify-center rounded-control bg-surface-2 text-ink-2">
              <Download className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-ink">Download my data</span>
              <span className="block text-[11px] text-ink-3">
                Loans, payments and reminders as one JSON file
              </span>
            </span>
            <ChevronRight className="size-4 text-ink-3" />
          </button>

          <button
            onClick={handleDelete}
            disabled={deleting}
            className="tap flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-2 disabled:opacity-60"
          >
            <span className="flex size-10 items-center justify-center rounded-control bg-bad-soft text-bad">
              <Trash2 className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-bad">
                {deleting ? "Deleting…" : "Delete my account"}
              </span>
              <span className="block text-[11px] text-ink-3">
                Refused while a loan is still running - a loan belongs to two people
              </span>
            </span>
          </button>

          {deleteError && (
            <div className="px-4 py-3.5">
              <Notice tone="bad">
                {deleteError}
                <Link href="/dashboard" className="mt-1 block font-semibold underline">
                  Go to my loans
                </Link>
              </Notice>
            </div>
          )}
        </Card>

        <SectionHeader title="About" className="mt-6" />
        <Card padded={false} className="divide-y divide-line">
          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex size-10 items-center justify-center rounded-control bg-surface-2 text-ink-2">
              <HandCoins className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-ink">Udhaar</span>
              <span className="block text-[11px] font-mono text-ink-3">1.0.0 MVP</span>
            </span>
          </div>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex size-10 items-center justify-center rounded-control bg-surface-2 text-ink-2">
              <Star className="size-5" />
            </span>
            <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink">Rate Udhaar</span>
            <ChevronRight className="size-4 text-ink-3" />
          </div>
        </Card>

        <Button
          block
          variant="secondary"
          className="mt-4 text-bad"
          icon={<LogOut className="size-4" />}
          onClick={handleLogout}
        >
          Log out
        </Button>
      </div>
    </MobileShell>
  );
}

/** A switch that says what it is actually doing while it does it. */
function Switch({ on, busy }: { on: boolean; busy?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "relative h-7 w-12 shrink-0 rounded-full transition-colors",
        on ? "bg-good" : "bg-line-strong",
        busy && "opacity-60"
      )}
    >
      <span
        className={cx(
          "absolute top-1 size-5 rounded-full bg-white shadow transition-transform",
          on ? "translate-x-6" : "translate-x-1"
        )}
      />
    </span>
  );
}
