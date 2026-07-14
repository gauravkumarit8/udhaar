/**
 * Native Bridge — Uses Capacitor plugins when running as native app,
 * falls back gracefully when running in browser.
 */

import { LocalNotifications, ScheduleOptions } from "@capacitor/local-notifications";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Share } from "@capacitor/share";
import { StatusBar, Style } from "@capacitor/status-bar";
import { SplashScreen } from "@capacitor/splash-screen";
import { Network } from "@capacitor/network";
import { App } from "@capacitor/app";

/**
 * Check if running as a native app (Capacitor)
 */
export function isNative(): boolean {
  if (typeof window === "undefined") return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  return !!(win.Capacitor?.isNativePlatform?.());
}

// ─── Notifications ───────────────────────────────────────────

export interface ReminderNotification {
  id: number;
  title: string;
  body: string;
  scheduledAt: Date;
  data?: Record<string, string>;
}

export async function scheduleReminder(notification: ReminderNotification): Promise<boolean> {
  try {
    if (isNative()) {
      // Request permission first
      const perm = await LocalNotifications.requestPermissions();
      if (perm.display !== "granted") return false;

      const options: ScheduleOptions = {
        notifications: [
          {
            id: notification.id,
            title: notification.title,
            body: notification.body,
            schedule: { at: notification.scheduledAt },
            extra: notification.data,
            sound: undefined,
            smallIcon: "ic_stat_icon",
            largeIcon: "ic_launcher",
          },
        ],
      };
      await LocalNotifications.schedule(options);
      return true;
    }
    // Web fallback — use browser Notification API
    if ("Notification" in window) {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return false;

      const delay = notification.scheduledAt.getTime() - Date.now();
      if (delay > 0) {
        setTimeout(() => {
          new Notification(notification.title, {
            body: notification.body,
            icon: "/icons/icon-192.png",
            tag: `udhaar-${notification.id}`,
          });
        }, delay);
      } else {
        new Notification(notification.title, {
          body: notification.body,
          icon: "/icons/icon-192.png",
          tag: `udhaar-${notification.id}`,
        });
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Schedule T-2, T-1, T0 + 7-day nag reminders for an installment
 */
export async function scheduleInstallmentReminders(
  installmentId: string,
  dueDate: string,
  borrowerName: string,
  amount: number
): Promise<void> {
  const due = new Date(dueDate + "T09:00:00");
  const dueTime = due.getTime();
  const now = Date.now();

  const reminders: Array<{ days: number; label: string }> = [
    { days: -2, label: "2 days away" },
    { days: -1, label: "Tomorrow" },
    { days: 0, label: "TODAY" },
  ];

  // T-2, T-1, T0
  for (const r of reminders) {
    const scheduledAt = new Date(dueTime + r.days * 24 * 60 * 60 * 1000);
    if (scheduledAt.getTime() > now) {
      await scheduleReminder({
        id: hashId(`${installmentId}-t${r.days}`),
        title: `💰 Payment Reminder — ${r.label}`,
        body: `${borrowerName} owes ₹${amount.toLocaleString("en-IN")}. Due ${new Date(dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}.`,
        scheduledAt,
        data: { installmentId, type: "reminder" },
      });
    }
  }

  // 7-day overdue nag
  for (let d = 1; d <= 7; d++) {
    const scheduledAt = new Date(dueTime + d * 24 * 60 * 60 * 1000);
    if (scheduledAt.getTime() > now) {
      await scheduleReminder({
        id: hashId(`${installmentId}-overdue-${d}`),
        title: `🔴 Overdue — ${d} day${d > 1 ? "s" : ""} past due`,
        body: `${borrowerName}'s payment of ₹${amount.toLocaleString("en-IN")} is ${d} day${d > 1 ? "s" : ""} overdue. Send a reminder now.`,
        scheduledAt,
        data: { installmentId, type: "overdue" },
      });
    }
  }
}

// Cancel all pending notifications for an installment
export async function cancelInstallmentReminders(installmentId: string): Promise<void> {
  if (!isNative()) return;
  try {
    const pending = await LocalNotifications.getPending();
    const ids = pending.notifications
      .filter((n) => n.extra?.installmentId === installmentId)
      .map((n) => n.id);
    if (ids.length > 0) {
      await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
    }
  } catch {
    // ignore
  }
}

// ─── Haptics ─────────────────────────────────────────────────

export async function hapticImpact(style: "light" | "medium" | "heavy" = "medium"): Promise<void> {
  try {
    if (isNative()) {
      const styles = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy };
      await Haptics.impact({ style: styles[style] });
    }
  } catch {
    // ignore
  }
}

export async function hapticNotification(type: "success" | "warning" | "error" = "success"): Promise<void> {
  try {
    if (isNative()) {
      const types = { success: NotificationType.Success, warning: NotificationType.Warning, error: NotificationType.Error };
      await Haptics.notification({ type: types[type] });
    }
  } catch {
    // ignore
  }
}

export async function hapticTap(): Promise<void> {
  try {
    if (isNative()) {
      await Haptics.impact({ style: ImpactStyle.Light });
    }
  } catch {
    // ignore
  }
}

// ─── Camera ──────────────────────────────────────────────────

export async function takePhoto(): Promise<string | null> {
  try {
    if (isNative()) {
      const photo = await Camera.getPhoto({
        quality: 80,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
      });
      return photo.dataUrl || null;
    }
    // Web fallback — file input
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.capture = "environment";
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        } else {
          resolve(null);
        }
      };
      input.click();
    });
  } catch {
    return null;
  }
}

export async function pickImage(): Promise<string | null> {
  try {
    if (isNative()) {
      const photo = await Camera.getPhoto({
        quality: 80,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Photos,
      });
      return photo.dataUrl || null;
    }
    // Web fallback
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        } else {
          resolve(null);
        }
      };
      input.click();
    });
  } catch {
    return null;
  }
}

// ─── Share ───────────────────────────────────────────────────

export async function shareContent(options: {
  title: string;
  text: string;
  url?: string;
}): Promise<boolean> {
  try {
    if (isNative()) {
      await Share.share(options);
      return true;
    }
    // Web fallback — Web Share API
    if (navigator.share) {
      await navigator.share(options);
      return true;
    }
    // Final fallback — copy to clipboard
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(options.text);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ─── Status Bar ──────────────────────────────────────────────

export async function setStatusBarDark(): Promise<void> {
  try {
    if (isNative()) {
      await StatusBar.setStyle({ style: Style.Dark });
      await StatusBar.setBackgroundColor({ color: "#064e3b" });
    }
  } catch {
    // ignore
  }
}

export async function setStatusBarLight(): Promise<void> {
  try {
    if (isNative()) {
      await StatusBar.setStyle({ style: Style.Light });
      await StatusBar.setBackgroundColor({ color: "#ffffff" });
    }
  } catch {
    // ignore
  }
}

// ─── Splash Screen ───────────────────────────────────────────

export async function hideSplash(): Promise<void> {
  try {
    if (isNative()) {
      await SplashScreen.hide({ fadeOutDuration: 300 });
    }
  } catch {
    // ignore
  }
}

// ─── Network ─────────────────────────────────────────────────

export function onNetworkChange(callback: (connected: boolean) => void): () => void {
  if (isNative()) {
    const handler = Network.addListener("networkStatusChange", (status) => {
      callback(status.connected);
    });
    return () => {
      handler.then((h) => h.remove());
    };
  }
  // Web fallback
  const online = () => callback(true);
  const offline = () => callback(false);
  window.addEventListener("online", online);
  window.addEventListener("offline", offline);
  return () => {
    window.removeEventListener("online", online);
    window.removeEventListener("offline", offline);
  };
}

export async function isOnline(): Promise<boolean> {
  if (isNative()) {
    const status = await Network.getStatus();
    return status.connected;
  }
  return navigator.onLine;
}

// ─── App Lifecycle ───────────────────────────────────────────

export function onAppResume(callback: () => void): () => void {
  if (isNative()) {
    const handler = App.addListener("appStateChange", (state) => {
      if (state.isActive) callback();
    });
    return () => {
      handler.then((h) => h.remove());
    };
  }
  // Web fallback — visibility change
  const handler = () => {
    if (document.visibilityState === "visible") callback();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}

// ─── Helpers ─────────────────────────────────────────────────

function hashId(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash) % 100000;
}
