"use client";

import { useShare, useHaptics } from "@/hooks/useNative";

interface ShareButtonProps {
  borrowerName: string;
  borrowerMobile: string;
  amount: string;
  upiId?: string | null;
}

export default function ShareButton({ borrowerName, borrowerMobile, amount, upiId }: ShareButtonProps) {
  const { share, shared } = useShare();
  const haptics = useHaptics();

  const handleShare = async () => {
    haptics.tap();
    const upiLine = upiId ? `\nUPI: ${upiId}` : "";
    await share({
      title: "Join me on Udhaar",
      text: `Hey! I'm tracking our loan on Udhaar — an easy way to manage EMIs and payments.\n\nLoan: ₹${parseFloat(amount).toLocaleString("en-IN")} from ${borrowerName}\nMobile: ${borrowerMobile}${upiLine}\n\nDownload Udhaar to track your loans with auto-reminders!`,
      url: window.location.origin,
    });
  };

  return (
    <button
      onClick={handleShare}
      className="flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-700 text-sm font-semibold tap-highlight active:bg-emerald-100 transition"
    >
      {shared ? "✓ Shared!" : "📤 Invite via WhatsApp/SMS"}
    </button>
  );
}
