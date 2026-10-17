"use client";

import { useState, useEffect, useCallback } from "react";
import { shouldRegisterForPush } from "@/lib/push-capability";
import {
  isNative,
  scheduleInstallmentReminders,
  cancelInstallmentReminders,
  registerForPushNotifications,
  hapticImpact,
  hapticNotification,
  hapticTap,
  takePhoto,
  pickImage,
  shareContent,
  setStatusBarDark,
  setStatusBarLight,
  hideSplash,
  onNetworkChange,
  onAppResume,
  isOnline as checkOnline,
  type ReminderNotification,
  scheduleReminder,
} from "@/lib/native";

/**
 * Check if running as a native Capacitor app.
 * The value is stable for the lifetime of the page, so it's read once on first
 * render (lazily, so SSR still sees `false`) instead of being pushed into
 * state from an effect.
 */
export function useIsNative() {
  const [native] = useState(() => isNative());
  return native;
}

/**
 * Registers the device for real push notifications, once, when `enabled`.
 *
 * `enabled` is not a nicety - it is what keeps the app alive. The native
 * register() call reaches FirebaseMessaging.getInstance(), which throws
 * IllegalStateException in a build that shipped without google-services.json
 * (no FirebaseApp). Capacitor turns a plugin exception into
 * `throw new RuntimeException(ex)` on the main thread, so the app is killed
 * outright - no promise rejection, nothing the page can catch.
 *
 * The backend answers whether it can send at all (`pushAvailable` on the
 * dashboard). Until it can, a token would be useless anyway, so there is no
 * reason to reach for the plugin and every reason not to.
 */
export function usePushRegistration(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    // Two separate facts have to agree, and they come from different places:
    // the server knows whether it can send (`enabled`), the build knows whether
    // it shipped Firebase (the user-agent marker). The second one is the one
    // that kills the process - see src/lib/push-capability.ts.
    const userAgent = typeof navigator === "undefined" ? null : navigator.userAgent;
    if (!shouldRegisterForPush({ native: isNative(), userAgent, serverCanSend: enabled })) return;
    registerForPushNotifications();
  }, [enabled]);
}

/** Network connectivity state */
export function useNetworkStatus() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    checkOnline().then(setOnline);
    const cleanup = onNetworkChange(setOnline);
    return cleanup;
  }, []);

  return online;
}

/** App resume (foreground) detection */
export function useAppResume(onResume: () => void) {
  useEffect(() => {
    const cleanup = onAppResume(onResume);
    return cleanup;
  }, [onResume]);
}

/** Photo capture hook */
export function useCamera() {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const capture = useCallback(async () => {
    setLoading(true);
    hapticTap();
    const result = await takePhoto();
    setPhotoUrl(result);
    setLoading(false);
    return result;
  }, []);

  const pick = useCallback(async () => {
    setLoading(true);
    hapticTap();
    const result = await pickImage();
    setPhotoUrl(result);
    setLoading(false);
    return result;
  }, []);

  const clear = useCallback(() => setPhotoUrl(null), []);

  return { photoUrl, loading, capture, pick, clear };
}

/** Share hook */
export function useShare() {
  const [shared, setShared] = useState(false);

  const share = useCallback(
    async (options: { title: string; text: string; url?: string }) => {
      hapticTap();
      const result = await shareContent(options);
      setShared(result);
      if (result) {
        hapticNotification("success");
        setTimeout(() => setShared(false), 3000);
      }
      return result;
    },
    []
  );

  return { share, shared };
}

/** Haptic feedback helpers */
export function useHaptics() {
  return {
    tap: hapticTap,
    impact: hapticImpact,
    notification: hapticNotification,
  };
}

/** Status bar control */
export function useStatusBar() {
  useEffect(() => {
    setStatusBarDark();
  }, []);

  return { setDark: setStatusBarDark, setLight: setStatusBarLight };
}

/** Splash screen auto-hide */
export function useSplashScreen() {
  useEffect(() => {
    const timer = setTimeout(() => {
      hideSplash();
    }, 1500);
    return () => clearTimeout(timer);
  }, []);
}

/** Schedule reminders for an installment */
export function useReminders() {
  const schedule = useCallback(
    async (
      installmentId: string,
      dueDate: string,
      borrowerName: string,
      amount: number
    ) => {
      await scheduleInstallmentReminders(installmentId, dueDate, borrowerName, amount);
      hapticNotification("success");
    },
    []
  );

  const cancel = useCallback(async (installmentId: string) => {
    await cancelInstallmentReminders(installmentId);
  }, []);

  const scheduleCustom = useCallback(async (notification: ReminderNotification) => {
    return scheduleReminder(notification);
  }, []);

  return { schedule, cancel, scheduleCustom };
}
