"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Installing the app, in one tap.
 *
 * Chrome and Android fire `beforeinstallprompt` when a site is installable,
 * and hand over an event that holds the prompt - but it can only be used once,
 * and only from where it was captured. Ignore it and the browser shows its own
 * quieter invitation later, or nothing at all; this is how the button on the
 * profile screen can install the app instead of explaining how to.
 *
 * Safari on iOS never fires it (installing there is Share → Add to Home
 * Screen), so `canInstall` stays false and the button stays hidden rather than
 * promising a tap that would do nothing.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function useInstallPrompt() {
  const [pending, setPending] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      // Keep the browser's own banner out of the way: the app offers the same
      // thing, in the place the person is already looking.
      event.preventDefault();
      setPending(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setPending(null);
      setInstalled(true);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  /** Returns what the person chose, or "unavailable" if there is nothing to show. */
  const install = useCallback(async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    if (!pending) return "unavailable";
    await pending.prompt();
    const { outcome } = await pending.userChoice;
    // A captured prompt cannot be reused - the event fires again if the app
    // becomes installable once more.
    setPending(null);
    if (outcome === "accepted") setInstalled(true);
    return outcome;
  }, [pending]);

  return { canInstall: Boolean(pending), installed, install };
}
