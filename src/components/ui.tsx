"use client";

/**
 * The primitives every screen is built from.
 *
 * Deliberately small and dependency-free: money apps are read in a hurry, and
 * a handful of parts that always behave the same way (a row that is always
 * tappable, a button that always shows its pressed state, a sheet that always
 * traps focus) is worth more than a long tail of bespoke markup. It is also
 * what makes the theme work - every colour here comes from a token, so dark
 * mode is a variable swap rather than a second set of components.
 */
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from "react";
import { useEffect, useRef } from "react";
import { Loader2, X } from "lucide-react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ── Money ───────────────────────────────────────────────────────────────── */

/**
 * `₹4,500` when the amount is whole, `₹4,500.50` when it isn't.
 *
 * Indian digit grouping, no decimal tail on round numbers: on a screen of
 * loans, the two extra characters are noise on every row and information on
 * almost none.
 */
export function formatMoney(amount: number | string): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(value)) return "₹0";

  const whole = Math.abs(value % 1) < 0.005;
  return `₹${value.toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** `₹4.5k` / `₹1.2L` - for a chip or a chart label, never for a balance. */
export function formatMoneyShort(amount: number): string {
  const value = Math.abs(amount);
  if (value >= 10_000_000) return `₹${(amount / 10_000_000).toFixed(1).replace(/\.0$/, "")}Cr`;
  if (value >= 100_000) return `₹${(amount / 100_000).toFixed(1).replace(/\.0$/, "")}L`;
  if (value >= 1_000) return `₹${(amount / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return formatMoney(amount);
}

export function Money({
  amount,
  className,
  short = false,
}: {
  amount: number | string;
  className?: string;
  short?: boolean;
}) {
  const value = typeof amount === "string" ? Number(amount) : amount;
  return (
    <span className={cx("tabular-nums", className)}>
      {short ? formatMoneyShort(value) : formatMoney(value)}
    </span>
  );
}

/* ── Avatar ──────────────────────────────────────────────────────────────── */

const AVATAR_TONES = [
  "bg-brand-soft text-brand-strong",
  "bg-warn-soft text-warn",
  "bg-good-soft text-good",
  "bg-bad-soft text-bad",
  "bg-surface-3 text-ink-2",
];

/**
 * A monogram whose colour is derived from the name, so the same person is the
 * same colour on every screen without anybody storing a colour.
 */
export function Avatar({
  name,
  size = 44,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const label = (name || "?").trim();
  const initial = label.charAt(0).toUpperCase() || "?";
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) % 997;
  const tone = AVATAR_TONES[hash % AVATAR_TONES.length];

  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-2xl font-bold",
        tone,
        className
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {initial}
    </span>
  );
}

/* ── Surfaces ────────────────────────────────────────────────────────────── */

export function Card({
  children,
  className,
  padded = true,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  as?: "div" | "section" | "li";
}) {
  return (
    <Tag
      className={cx(
        "rounded-card border border-line bg-surface shadow-card",
        padded && "p-4",
        className
      )}
    >
      {children}
    </Tag>
  );
}

/** A section heading with an optional action on the right. */
export function SectionHeader({
  title,
  count,
  action,
  className,
}: {
  title: string;
  count?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mb-2.5 flex items-end justify-between gap-3", className)}>
      <h2 className="flex items-baseline gap-2 text-[15px] font-semibold tracking-tight text-ink">
        {title}
        {count !== undefined && <span className="text-xs font-medium text-ink-3">{count}</span>}
      </h2>
      {action}
    </div>
  );
}

/* ── Controls ────────────────────────────────────────────────────────────── */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand text-brand-ink hover:bg-brand-strong",
  secondary: "bg-surface-2 text-ink hover:bg-surface-3 border border-line",
  ghost: "bg-transparent text-ink-2 hover:bg-surface-2",
  danger: "bg-bad text-white hover:opacity-90",
  success: "bg-good text-white hover:opacity-90",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-[13px] gap-1.5 rounded-control",
  md: "h-11 px-4 text-sm gap-2 rounded-control",
  lg: "h-13 px-5 text-[15px] gap-2 rounded-card",
};

/**
 * The button's look, for the places that must be an `<a>` and not a `<button>`
 * - a UPI deep link, a tel: link, anything the operating system has to handle
 * rather than the page. Same shape, same press feedback, different element.
 */
export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  extra?: string
): string {
  return cx(
    "tap inline-flex items-center justify-center font-semibold",
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    extra
  );
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  block = false,
  icon,
  children,
  className,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        "disabled:pointer-events-none disabled:opacity-50",
        buttonClasses(variant, size),
        block && "w-full",
        className
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin-slow" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className,
  ...rest
}: { label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        "tap inline-flex size-10 items-center justify-center rounded-full text-ink-2",
        "hover:bg-surface-2 disabled:opacity-50",
        className
      )}
    >
      {children}
    </button>
  );
}

/** A small tinted label: a role, a status, a count. */
export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "good" | "warn" | "bad";
  className?: string;
}) {
  const tones = {
    neutral: "bg-surface-3 text-ink-2",
    brand: "bg-brand-soft text-brand-strong",
    good: "bg-good-soft text-good",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad",
  } as const;

  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/** The chip row used for filters and quick amounts. */
export function Chip({
  active = false,
  children,
  className,
  ...rest
}: { active?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      aria-pressed={active}
      className={cx(
        "tap shrink-0 rounded-full border px-3.5 py-2 text-[13px] font-semibold whitespace-nowrap",
        active
          ? "border-transparent bg-ink text-surface"
          : "border-line bg-surface text-ink-2 hover:bg-surface-2",
        className
      )}
    >
      {children}
    </button>
  );
}

/** A row of chips where exactly one can be chosen (or none, when optional). */
export function ChipGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="group" className={cx("-mx-4 flex gap-2 overflow-x-auto px-4 py-0.5", className)}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink-2">{label}</span>
        {hint && <span className="text-[11px] font-medium text-ink-3">{hint}</span>}
      </span>
      {children}
      {error && <span className="mt-1.5 block text-[12px] font-medium text-bad">{error}</span>}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cx(
        "w-full rounded-control border border-line bg-surface px-3.5 py-3 text-[15px] text-ink",
        "placeholder:text-ink-3 focus:border-brand focus:outline-none focus:ring-4 focus:ring-[var(--ring)]",
        className
      )}
    />
  );
}

/* ── Progress ────────────────────────────────────────────────────────────── */

export function Progress({
  value,
  tone = "brand",
  className,
}: {
  /** 0-100. Values outside are clamped rather than drawn outside the track. */
  value: number;
  tone?: "brand" | "good" | "warn" | "bad";
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const tones = { brand: "bg-brand", good: "bg-good", warn: "bg-warn", bad: "bg-bad" } as const;

  return (
    <div
      className={cx("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cx("h-full rounded-full transition-[width] duration-500", tones[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ── States ──────────────────────────────────────────────────────────────── */

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center px-6 py-10 text-center", className)}>
      {icon && (
        <div className="mb-3 flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-ink-2">
          {icon}
        </div>
      )}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {body && <p className="mt-1 max-w-[38ch] text-[13px] leading-relaxed text-ink-3">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** An inline, non-blocking message: an error to fix, or a thing that worked. */
export function Notice({
  tone = "warn",
  icon,
  children,
  className,
  onDismiss,
}: {
  tone?: "warn" | "bad" | "good" | "brand" | "neutral";
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  onDismiss?: () => void;
}) {
  const tones = {
    neutral: "bg-surface-2 text-ink-2",
    brand: "bg-brand-soft text-brand-strong",
    good: "bg-good-soft text-good",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad",
  } as const;

  return (
    <div
      role={tone === "bad" || tone === "warn" ? "alert" : "status"}
      className={cx(
        "flex items-start gap-2.5 rounded-control px-3.5 py-3 text-[13px] font-medium",
        tones[tone],
        className
      )}
    >
      {icon && <span className="mt-px shrink-0">{icon}</span>}
      <div className="flex-1 leading-snug">{children}</div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="tap -mr-1 -mt-0.5 shrink-0 rounded-full p-1 opacity-70 hover:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton rounded-control", className)} />;
}

/* ── Sheet ───────────────────────────────────────────────────────────────── */

/**
 * The bottom sheet every action happens in.
 *
 * Drag-to-dismiss, Escape to close, background scroll locked, focus moved into
 * the sheet and returned on close, and a sticky footer for the primary action
 * so the thing to tap is never below the fold. On a wide screen it becomes a
 * centred dialog rather than a full-width strip, because a 900px-wide sheet
 * with one button in it looks like a mistake.
 */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = "auto",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "auto" | "tall";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef(0);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus in so a keyboard user is inside the dialog, not behind it.
    const focusTimer = window.setTimeout(() => {
      const marked = panelRef.current?.querySelector<HTMLElement>("[data-autofocus]");
      const first =
        marked ??
        panelRef.current?.querySelector<HTMLElement>("input, button, a[href], textarea, select");
      first?.focus({ preventScroll: true });
    }, 60);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const onTouchStart = (event: React.TouchEvent) => {
    dragStart.current = event.touches[0].clientY;
  };
  const onTouchMove = (event: React.TouchEvent) => {
    const delta = event.touches[0].clientY - dragStart.current;
    if (delta > 0 && panelRef.current) {
      panelRef.current.style.transform = `translateY(${delta}px)`;
      panelRef.current.style.transition = "none";
    }
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    const delta = event.changedTouches[0].clientY - dragStart.current;
    if (panelRef.current) {
      panelRef.current.style.transition = "";
      panelRef.current.style.transform = "";
    }
    if (delta > 90) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px] animate-fade"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        className={cx(
          "animate-sheet relative flex w-full flex-col bg-surface shadow-float",
          "rounded-t-sheet sm:max-w-md sm:rounded-card",
          size === "tall" ? "max-h-[88vh]" : "max-h-[82vh]"
        )}
      >
        {/* Drag handle - mobile only, where dragging is the expected gesture. */}
        <div className="flex justify-center pt-2.5 sm:hidden">
          <div className="h-1 w-9 rounded-full bg-line-strong" />
        </div>

        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
          <div className="min-w-0">
            <h3 className="text-[17px] font-bold tracking-tight text-ink">{title}</h3>
            {subtitle && <p className="mt-0.5 text-[13px] leading-snug text-ink-2">{subtitle}</p>}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mt-1 -mr-2">
            <X className="size-5" />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 overscroll-contain">
          {children}
        </div>

        {footer && (
          <div className="safe-bottom border-t border-line bg-surface px-5 py-3.5">{footer}</div>
        )}
      </div>
    </div>
  );
}

/* ── Layout helpers ──────────────────────────────────────────────────────── */

/** A definition row: label on the left, value on the right, optional note. */
export function DetailRow({
  label,
  value,
  note,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex items-start justify-between gap-4 py-2", className)}>
      <span className="text-[13px] text-ink-2">{label}</span>
      <span className="text-right text-[13px] font-semibold text-ink">
        {value}
        {note && <span className="mt-0.5 block text-[11px] font-medium text-ink-3">{note}</span>}
      </span>
    </div>
  );
}

/** The sticky action bar at the bottom of a detail screen. */
export function ActionBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur-xl",
        className
      )}
    >
      <div className="mx-auto flex w-full max-w-lg items-center gap-2 px-4 py-3">{children}</div>
    </div>
  );
}
