"use client";

import { useState } from "react";
import { Camera, Check, ImageIcon, Trash2 } from "lucide-react";
import { Notice, Skeleton, buttonClasses, cx } from "@/components/ui";
import { useCamera, useHaptics } from "@/hooks/useNative";

interface ProofUploadProps {
  /**
   * The uploaded proof's id (`udhaar/proofs/…`), or "" when it is removed.
   * Not a URL: proofs are private, so the id is what the payment stores and
   * what /api/payments/[id]/proof later signs.
   */
  onCapture: (proofId: string) => void;
  /** Told when the attached photo is taken back off, so the form can forget it. */
  onClear?: () => void;
}

/**
 * Attach a screenshot to a payment.
 *
 * A photo of a UPI receipt is what settles an argument six months later, and it
 * is optional - so it is one row here rather than a panel: take one, or pick
 * one, or ignore it and carry on. The file that already went to storage is the
 * same one shown as the preview, because a private asset has no public URL to
 * show instead (anyone else sees it through /api/payments/[id]/proof).
 */
export default function ProofUpload({ onCapture, onClear }: ProofUploadProps) {
  const { loading: cameraLoading, capture, pick, clear } = useCamera();
  const haptics = useHaptics();
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Proofs are an optional integration. When the deployment has no storage
   * configured the upload answers 503, and the message it carries is written
   * for whoever runs the server ("set CLOUDINARY_…"). Showing that to someone
   * who is halfway through recording a payment tells them nothing they can act
   * on, so the borrower gets the useful half instead: the money can still be
   * recorded without a screenshot.
   */
  const [unavailable, setUnavailable] = useState(false);

  async function uploadAndNotify(dataUrl: string) {
    setError(null);
    setLocalPreview(dataUrl); // instant feedback while the upload is in flight
    setUploading(true);
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      const data = await res.json();
      if (res.status === 503) {
        // Worth a console line for whoever is debugging the deployment, but
        // not worth showing to the person making the payment.
        console.warn("[proof] storage is not configured:", data.error);
        setUnavailable(true);
        setLocalPreview(null);
        clear();
        return;
      }
      if (!res.ok) throw new Error(data.error || "Upload failed");
      onCapture(data.proofId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't upload the photo. Try again.");
      setLocalPreview(null);
      clear();
      onClear?.();
    } finally {
      setUploading(false);
    }
  }

  const handleCapture = async () => {
    haptics.tap();
    const result = await capture();
    if (result) await uploadAndNotify(result);
  };

  const handlePick = async () => {
    haptics.tap();
    const result = await pick();
    if (result) await uploadAndNotify(result);
  };

  const handleRemove = () => {
    clear();
    setLocalPreview(null);
    setError(null);
    onCapture("");
    onClear?.();
  };

  const loading = cameraLoading || uploading;

  return (
    <div className="space-y-2">
      {localPreview ? (
        <div className="flex items-center gap-3 rounded-control border border-line bg-surface p-2.5">
          <div className="relative size-14 shrink-0 overflow-hidden rounded-control bg-surface-2">
            {/* Deliberately a plain <img>. `next/image` is switched off app-wide
                (next.config.ts → images.unoptimized) because the standalone
                container has no image server, so it would only wrap this in an
                extra component - and its optimizer cannot handle a `data:` URL,
                which is what the preview is until the upload finishes. The
                already-uploaded alternative is a Cloudinary URL, which is
                resized at the CDN and needs no help from Next. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={localPreview} alt="Payment proof" className="size-full object-cover" />
          </div>
          <div className="min-w-0 flex-1">
            {uploading ? (
              <>
                <p className="text-[13px] font-semibold text-ink">Uploading proof…</p>
                <Skeleton className="mt-1.5 h-2.5 w-24" />
              </>
            ) : (
              <>
                <p className="flex items-center gap-1.5 text-[13px] font-semibold text-good">
                  <Check className="size-3.5" /> Proof attached
                </p>
                <p className="text-[11px] text-ink-3">
                  Only the two of you can see it - it is not a public link.
                </p>
              </>
            )}
          </div>
          {!uploading && (
            <button
              onClick={handleRemove}
              aria-label="Remove proof"
              className="tap flex size-9 shrink-0 items-center justify-center rounded-full text-bad hover:bg-surface-2"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      ) : unavailable ? (
        <Notice tone="neutral">
          Proof uploads aren&apos;t switched on for this app yet - you can still record the
          payment without a screenshot.
        </Notice>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={handleCapture}
            disabled={loading}
            className={cx(
              buttonClasses("secondary", "md", "w-full flex-col gap-1 py-3 h-auto"),
              "disabled:opacity-50"
            )}
          >
            <Camera className="size-5" />
            <span className="text-[11px] font-semibold">Take photo</span>
          </button>
          <button
            onClick={handlePick}
            disabled={loading}
            className={cx(
              buttonClasses("secondary", "md", "w-full flex-col gap-1 py-3 h-auto"),
              "disabled:opacity-50"
            )}
          >
            <ImageIcon className="size-5" />
            <span className="text-[11px] font-semibold">Choose photo</span>
          </button>
        </div>
      )}

      {error && <p className="text-[12px] font-medium text-bad">{error}</p>}
    </div>
  );
}
