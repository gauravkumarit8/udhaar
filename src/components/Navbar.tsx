"use client";

import { useState, useEffect } from "react";

export default function Navbar({ user: userProp }: { user?: { name: string; mobile: string } | null }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [user, setUser] = useState(userProp ?? null);

  useEffect(() => {
    if (!userProp) {
      fetch("/api/auth/me")
        .then((r) => r.json())
        .then((data) => {
          if (data.user) setUser(data.user);
        })
        .catch(() => {});
    }
  }, [userProp]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  return (
    <nav className="bg-emerald-700 text-white shadow-lg">
      <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
        <a href="/dashboard" className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <span className="text-2xl">💰</span>
          <span>Udhaar</span>
        </a>

        <div className="flex items-center gap-3">
          <a
            href="/loans/new"
            className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-3 py-1.5 rounded-lg transition hidden sm:block"
          >
            + New Loan
          </a>

          {user && (
            <div className="relative">
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 rounded-full px-3 py-1.5 text-sm font-medium transition"
              >
                <span className="w-7 h-7 bg-white text-emerald-700 rounded-full flex items-center justify-center font-bold text-xs">
                  {user.name.charAt(0).toUpperCase()}
                </span>
                <span className="hidden sm:inline">{user.name}</span>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {menuOpen && (
                <div className="absolute right-0 mt-2 w-48 bg-white text-gray-800 rounded-lg shadow-xl py-1 z-50">
                  <div className="px-4 py-2 text-xs text-gray-500 border-b">
                    {user.mobile}
                  </div>
                  <a
                    href="/dashboard"
                    className="block px-4 py-2 text-sm hover:bg-gray-100"
                    onClick={() => setMenuOpen(false)}
                  >
                    📊 Dashboard
                  </a>
                  <a
                    href="/loans/new"
                    className="block px-4 py-2 text-sm hover:bg-gray-100"
                    onClick={() => setMenuOpen(false)}
                  >
                    ➕ Add Loan
                  </a>
                  <button
                    onClick={handleLogout}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 text-red-600"
                  >
                    🚪 Logout
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
