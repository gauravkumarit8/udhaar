"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useHaptics } from "@/hooks/useNative";

const tabs = [
  { href: "/dashboard", label: "Home", icon: "home" },
  { href: "/loans/new", label: "Add", icon: "plus" },
  { href: "/activity", label: "Activity", icon: "bell" },
  { href: "/profile", label: "Profile", icon: "person" },
];

export default function BottomNav() {
  const pathname = usePathname();
  const haptics = useHaptics();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-xl border-t border-slate-200/60 safe-area-bottom">
      <div className="max-w-lg mx-auto flex items-center justify-around h-16">
        {tabs.map((tab) => {
          const isActive =
            tab.href === "/dashboard"
              ? pathname === "/dashboard" || pathname === "/"
              : pathname.startsWith(tab.href);

          const handleClick = () => {
            haptics.tap();
          };

          return (
            <a
              key={tab.href}
              href={tab.href}
              onClick={handleClick}
              className={`flex flex-col items-center justify-center w-16 h-full transition-all tap-highlight ${
                isActive ? "text-emerald-600" : "text-slate-400"
              }`}
            >
              {tab.icon === "plus" ? (
                <div className="absolute -top-3 w-12 h-12 bg-emerald-600 rounded-full flex items-center justify-center shadow-lg shadow-emerald-600/30">
                  <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                </div>
              ) : (
                <TabIcon name={tab.icon} active={isActive} className="w-6 h-6" />
              )}
              <span
                className={`text-[10px] mt-0.5 font-medium ${
                  tab.icon === "plus" ? "mt-7" : ""
                } ${isActive ? "text-emerald-600" : "text-slate-400"}`}
              >
                {tab.label}
              </span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}

function TabIcon({ name, active, className }: { name: string; active: boolean; className?: string }) {
  if (name === "home") {
    return active ? (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.71 2.29a1 1 0 00-1.42 0l-9 9a1 1 0 001.42 1.42L4 12.41V21a1 1 0 001 1h4a1 1 0 001-1v-4h4v4a1 1 0 001 1h4a1 1 0 001-1v-8.59l.29.3a1 1 0 001.42-1.42l-9-9z" />
      </svg>
    ) : (
      <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
      </svg>
    );
  }

  if (name === "bell") {
    return active ? (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
      </svg>
    ) : (
      <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
      </svg>
    );
  }

  // person
  return active ? (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
    </svg>
  ) : (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
    </svg>
  );
}
