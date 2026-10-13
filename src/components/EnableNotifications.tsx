"use client";

import { useEffect, useState } from "react";
import { browserPushState, enableBrowserPush, type BrowserPushState } from "@/lib/webpush-client";

const DISMISSED_KEY = "udhaar.pushPromptDismissed";

/**
 * The one place a person is asked to turn notifications on.
 *
 * It only appears when the browser hasn't been asked yet (`default`) and the
 * server is actually able to send (VAPID keys set) - promising notifications
 * that cannot arrive is worse than saying nothing. The permission prompt has
 * to come from a tap, so this is a card with a button rather than an automatic
 * request on page load.
 */
export default function EnableNotifications() {
  const [state, setState] = useState<BrowserPushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (typeof window !== "undefined" && window.localStorage.getItem(DISMISSED_KEY) === "1") {
        return;
      }
      const current = await browserPushState();
      if (!cancelled) setState(current);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state !== "default") return null;

  const handleEnable = async () => {
    setBusy(true);
    const result = await enableBrowserPush();
    setBusy(false);

    if (result.ok) {
      setState("granted-subscribed");
      return;
    }
    setNote(result.reason);
  };

  return (
    <div className="bg-white rounded-2xl border border-emerald-100 p-4 mb-4 animate-scale-in">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 bg-emerald-50 rounded-xl flex items-center justify-center text-lg shrink-0">
          🔔
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-sm text-slate-800">Turn on notifications</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Get told the moment someone adds a loan for you, marks a payment, or confirms one -
            even when Udhaar is closed.
          </p>
          {note && <p className="text-xs text-amber-700 mt-2">{note}</p>}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={handleEnable}
              disabled={busy}
              className="bg-emerald-600 text-white text-xs font-semibold px-4 py-2 rounded-xl tap-highlight disabled:opacity-60"
            >
              {busy ? "Turning on…" : "Enable notifications"}
            </button>
            <button
              onClick={() => {
                window.localStorage.setItem(DISMISSED_KEY, "1");
                setState(null);
              }}
              className="text-xs text-slate-400 font-medium px-2 py-2"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
