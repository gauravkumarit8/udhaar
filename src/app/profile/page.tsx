"use client";

import { useState, useEffect } from "react";
import BottomNav from "@/components/BottomNav";
import MobileShell from "@/components/MobileShell";
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

  return (
    <MobileShell title="Profile">
      <div className="px-5 pb-24">
        {/* Profile Card */}
        <div className="bg-gradient-to-br from-emerald-600 to-emerald-700 rounded-3xl p-6 text-center mb-6 shadow-lg shadow-emerald-600/20">
          <div className="w-20 h-20 bg-white/20 rounded-full flex items-center justify-center text-3xl text-white font-bold mx-auto mb-3">
            {user?.name?.charAt(0).toUpperCase() || "U"}
          </div>
          <h2 className="text-2xl font-extrabold text-white">{user?.name || "User"}</h2>
          <p className="text-emerald-200 mt-1">+91 {user?.mobile || "—"}</p>
        </div>

        {/* Settings Sections */}
        <div className="space-y-3">
          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wide px-4 pt-4 pb-2">
              Notification Preferences
            </h3>
            <ToggleRow
              label="Push Notifications"
              icon="📱"
              on={user?.pushEnabled ?? true}
              disabled={!loading && !user}
              onToggle={togglePush}
              hint={
                browserPush === "granted-subscribed"
                  ? "This device is registered"
                  : browserPush === "denied"
                    ? "Blocked in your browser settings"
                    : browserPush === "not-configured"
                      ? "The server has no VAPID keys yet"
                      : browserPush === "unsupported"
                        ? "This browser can't show notifications"
                        : undefined
              }
            />
            {pushNote && (
              <p className="px-4 py-3 text-xs text-amber-700 border-t border-slate-50">{pushNote}</p>
            )}
            {/* Reminders on WhatsApp/SMS are sent from the lender's own
                phone, so they are not a preference to toggle - they are how
                the reminder reaches someone who never installed Udhaar. */}
            <div className="px-4 py-3 border-t border-slate-50">
              <div className="flex items-center gap-3">
                <span className="text-lg">📲</span>
                <span className="text-sm text-slate-700">WhatsApp reminders</span>
              </div>
              <p className="text-xs text-slate-400 mt-1 ml-8">
                The reminder opens in your own WhatsApp, ready to send — so the borrower
                doesn&apos;t need this app installed.
              </p>
            </div>
            <div className="px-4 py-3 border-t border-slate-50">
              <div className="flex items-center gap-3">
                <span className="text-lg">💬</span>
                <span className="text-sm text-slate-700">Automatic SMS</span>
              </div>
              <p className="text-xs text-slate-400 mt-1 ml-8">
                {channels.sms
                  ? "MSG91 is configured — OTPs are sent for real."
                  : "Not set up: SMS is only used for OTPs once MSG91 keys are added. Reminders go through your own phone."}
              </p>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wide px-4 pt-4 pb-2">
              Reminder Schedule
            </h3>
            <p className="px-4 pb-4 text-xs text-slate-400">
              Udhaar nudges the borrower 2 days before, 1 day before and on the due date, then daily
              while it stays unpaid. From a loan page you can send a reminder on WhatsApp or by SMS,
              or as an in-app notification if the borrower installed Udhaar.
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wide px-4 pt-4 pb-2">
              About
            </h3>
            <div className="px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-lg">💰</span>
                <span className="text-sm text-slate-700">Version</span>
              </div>
              <span className="text-sm text-slate-400 font-mono">1.0.0 MVP</span>
            </div>
            <div className="px-4 py-3 flex items-center justify-between border-t border-slate-50">
              <div className="flex items-center gap-3">
                <span className="text-lg">⭐</span>
                <span className="text-sm text-slate-700">Rate Udhaar</span>
              </div>
              <svg className="w-4 h-4 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </div>
            <div className="px-4 py-3 flex items-center justify-between border-t border-slate-50">
              <div className="flex items-center gap-3">
                <span className="text-lg">🤝</span>
                <span className="text-sm text-slate-700">Invite a Friend</span>
              </div>
              <svg className="w-4 h-4 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wide px-4 pt-4 pb-2">
              Your data
            </h3>
            <p className="px-4 pb-3 text-xs text-slate-400">
              Yours to take with you: loans, payments, reminders — everything the app holds about
              you, as one file.
            </p>
            <button
              onClick={handleExport}
              className="w-full text-left px-4 py-3 flex items-center justify-between border-t border-slate-50 tap-highlight active:bg-slate-50"
            >
              <span className="flex items-center gap-3">
                <span className="text-lg">⬇️</span>
                <span className="text-sm text-slate-700 font-medium">Download my data</span>
              </span>
              <span className="text-[10px] text-slate-400 font-medium">JSON</span>
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="w-full text-left px-4 py-3 flex items-center justify-between border-t border-slate-50 tap-highlight active:bg-red-50 disabled:opacity-60"
            >
              <span className="flex items-center gap-3">
                <span className="text-lg">🗑️</span>
                <span className="text-sm text-red-600 font-medium">
                  {deleting ? "Deleting…" : "Delete my account"}
                </span>
              </span>
            </button>
            {deleteError && (
              <div className="px-4 py-3 border-t border-red-100 bg-red-50">
                <p className="text-xs text-red-700">{deleteError}</p>
                <a href="/dashboard" className="text-xs font-semibold text-red-700 underline mt-1 inline-block">
                  Go to my loans
                </a>
              </div>
            )}
          </div>

          <button
            onClick={handleLogout}
            className="w-full bg-white border border-red-200 rounded-2xl py-4 text-red-600 font-semibold text-sm tap-highlight active:bg-red-50 transition"
          >
            🚪 Logout
          </button>
        </div>
      </div>

      <BottomNav />
    </MobileShell>
  );
}

function ToggleRow({
  label,
  icon,
  on,
  disabled = false,
  hint,
  onToggle,
}: {
  label: string;
  icon: string;
  on: boolean;
  disabled?: boolean;
  hint?: string;
  onToggle?: () => void;
}) {
  return (
    <div className="px-4 py-3 flex items-center justify-between border-t border-slate-50">
      <div className="flex items-center gap-3">
        <span className="text-lg">{icon}</span>
        <span className={`text-sm ${disabled ? "text-slate-400" : "text-slate-700"}`}>{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {hint && <span className="text-[10px] text-slate-400 font-medium">{hint}</span>}
        <button
          type="button"
          disabled={disabled || !onToggle}
          aria-pressed={on}
          onClick={onToggle}
          className={`relative w-12 h-7 rounded-full transition-colors disabled:opacity-40 ${
            on ? "bg-emerald-500" : "bg-slate-300"
          }`}
        >
          <div
            className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow transition-transform ${
              on ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>
    </div>
  );
}
