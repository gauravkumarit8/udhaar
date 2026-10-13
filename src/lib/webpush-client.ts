/**
 * Browser side of Web Push: asks the server for its public key, subscribes
 * this browser, and hands the subscription back.
 *
 * Everything here is best-effort and silent on failure - the app works without
 * notifications, so the only thing a broken subscribe flow may do is leave the
 * button unsaid.
 */

export type BrowserPushState =
  | "unsupported" // no service worker / Push API (older iOS Safari in a tab)
  | "not-configured" // the server has no VAPID keys yet
  | "default" // we haven't asked the user yet
  | "denied" // the user said no - we must not ask again
  | "granted-subscribed" // on and working
  | "granted-unsubscribed"; // allowed, but this browser isn't registered

/**
 * VAPID keys are base64url; the Push API wants raw bytes.
 *
 * The buffer is allocated explicitly (rather than a plain `new Uint8Array`)
 * because `applicationServerKey` requires an ArrayBuffer-backed view.
 */
function keyToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalised);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function browserPushSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

interface ServerPushConfig {
  configured: boolean;
  publicKey: string | null;
}

async function serverConfig(): Promise<ServerPushConfig> {
  try {
    const res = await fetch("/api/notifications/register-device", { cache: "no-store" });
    if (!res.ok) return { configured: false, publicKey: null };
    const data = await res.json();
    return {
      configured: Boolean(data?.webPush?.configured),
      publicKey: data?.webPush?.publicKey ?? null,
    };
  } catch {
    return { configured: false, publicKey: null };
  }
}

/** What the UI should show right now, without asking the user anything. */
export async function browserPushState(): Promise<BrowserPushState> {
  if (!browserPushSupported()) return "unsupported";

  const config = await serverConfig();
  if (!config.configured || !config.publicKey) return "not-configured";

  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "default";

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    return existing ? "granted-subscribed" : "granted-unsubscribed";
  } catch {
    return "granted-unsubscribed";
  }
}

/**
 * Turns notifications on for this browser. Must be called from a user gesture
 * (a click) - browsers refuse the permission prompt otherwise.
 */
export async function enableBrowserPush(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  if (!browserPushSupported()) {
    return { ok: false, reason: "This browser can't show notifications." };
  }

  const config = await serverConfig();
  if (!config.configured || !config.publicKey) {
    return {
      ok: false,
      reason: "Notifications aren't set up on the server yet (VAPID keys are missing).",
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      ok: false,
      reason:
        permission === "denied"
          ? "Notifications are blocked for this site - allow them in your browser settings."
          : "Notification permission was not granted.",
    };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyToBytes(config.publicKey),
      }));

    const res = await fetch("/api/notifications/register-device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });

    if (!res.ok) return { ok: false, reason: "The server couldn't save this device." };

    return { ok: true };
  } catch {
    return { ok: false, reason: "This browser refused to subscribe for notifications." };
  }
}

/** Turns notifications off for this browser and forgets the subscription. */
export async function disableBrowserPush(): Promise<boolean> {
  if (!browserPushSupported()) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;

    const endpoint = subscription.endpoint;

    await subscription.unsubscribe();
    await fetch("/api/notifications/register-device", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });

    return true;
  } catch {
    return false;
  }
}
