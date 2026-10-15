"use client";

import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { Button, Card } from "@/components/ui";
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
    <Card className="overflow-hidden border-brand/25 bg-brand-soft">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-surface text-brand-strong">
          <BellRing className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-brand-strong">Turn on notifications</h3>
          <p className="mt-0.5 text-[12px] leading-relaxed text-brand-strong/85">
            Get told the moment someone adds a loan for you, marks a payment, or confirms one -
            even when Udhaar is closed.
          </p>
          {note && <p className="mt-2 text-[12px] font-medium text-bad">{note}</p>}
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" loading={busy} onClick={handleEnable}>
              {busy ? "Turning on" : "Enable notifications"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                window.localStorage.setItem(DISMISSED_KEY, "1");
                setState(null);
              }}
            >
              Not now
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
