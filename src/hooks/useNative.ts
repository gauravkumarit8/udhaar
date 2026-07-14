"use client";

import { useState, useEffect, useCallback } from "react";
import {
  isNative,
  scheduleInstallmentReminders,
  cancelInstallmentReminders,
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

/** Check if running as native Capacitor app */
export function useIsNative() {
  const [native, setNative] = useState(false);

  useEffect(() => {
    setNative(isNative());
  }, []);

  return native;
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
