"use client";

import { useState, useEffect } from "react";
import BottomNav from "@/components/BottomNav";
import MobileShell from "@/components/MobileShell";

interface User {
  id: string;
  name: string;
  mobile: string;
}

export default function ProfilePage() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/auth/me");
        if (res.ok) {
          const data = await res.json();
          if (data.user) setUser(data.user);
          else window.location.href = "/login";
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
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
            <SettingToggle label="Push Notifications" icon="📱" defaultOn={true} />
            <SettingToggle label="SMS Reminders" icon="💬" defaultOn={true} />
            <SettingToggle label="WhatsApp Reminders" icon="📲" defaultOn={false} />
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wide px-4 pt-4 pb-2">
              Reminder Schedule
            </h3>
            <SettingToggle label="T-2 (2 days before)" icon="📅" defaultOn={true} />
            <SettingToggle label="T-1 (1 day before)" icon="📋" defaultOn={true} />
            <SettingToggle label="Overdue Nag Mode" icon="🔴" defaultOn={true} />
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

function SettingToggle({
  label,
  icon,
  defaultOn,
}: {
  label: string;
  icon: string;
  defaultOn: boolean;
}) {
  const [on, setOn] = useState(defaultOn);

  return (
    <div className="px-4 py-3 flex items-center justify-between border-t border-slate-50">
      <div className="flex items-center gap-3">
        <span className="text-lg">{icon}</span>
        <span className="text-sm text-slate-700">{label}</span>
      </div>
      <button
        onClick={() => setOn(!on)}
        className={`relative w-12 h-7 rounded-full transition-colors ${
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
  );
}
