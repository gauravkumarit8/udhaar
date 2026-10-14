"use client";

import { useState } from "react";
import { useCamera, useHaptics } from "@/hooks/useNative";

interface ProofUploadProps {
  /**
   * The uploaded proof's id (`udhaar/proofs/…`), or "" when it is removed.
   * Not a URL: proofs are private, so the id is what the payment stores and
   * what /api/payments/[id]/proof later signs.
   */
  onCapture: (proofId: string) => void;
}

export default function ProofUpload({ onCapture }: ProofUploadProps) {
  const { loading: cameraLoading, capture, pick, clear } = useCamera();
  const haptics = useHaptics();
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      if (!res.ok) throw new Error(data.error || "Upload failed");
      onCapture(data.proofId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't upload the photo. Try again.");
      setLocalPreview(null);
      clear();
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
  };

  // The captured image stays on screen as the preview: it is the exact file
  // that was uploaded. The uploaded copy is private, so there is no URL to
  // show for it - anyone else sees it through /api/payments/[id]/proof.
  const displayUrl = localPreview;
  const loading = cameraLoading || uploading;

  return (
    <div className="space-y-2">
      <label className="block text-sm font-semibold text-slate-700">
        📸 Payment Proof
      </label>

      {displayUrl ? (
        <div className="relative rounded-2xl overflow-hidden border border-slate-200">
          {/* Deliberately a plain <img>. `next/image` is switched off app-wide
              (next.config.ts → images.unoptimized) because the standalone
              container has no image server, so it would only wrap this in an
              extra component - and its optimizer cannot handle a `data:` URL,
              which is what the preview is until the upload finishes. The
              already-uploaded alternative is a Cloudinary URL, which is
              resized at the CDN and needs no help from Next. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={displayUrl}
            alt="Payment proof"
            className="w-full h-40 object-cover"
          />
          {uploading && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <span className="text-white text-xs font-semibold">Uploading…</span>
            </div>
          )}
          {!uploading && (
            <button
              onClick={handleRemove}
              className="absolute top-2 right-2 w-8 h-8 bg-red-500 text-white rounded-full flex items-center justify-center text-sm shadow-lg tap-highlight"
            >
              ✕
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={handleCapture}
            disabled={loading}
            className="flex flex-col items-center gap-2 py-4 bg-emerald-50 border-2 border-dashed border-emerald-300 rounded-2xl text-emerald-600 tap-highlight disabled:opacity-50"
          >
            <span className="text-2xl">📷</span>
            <span className="text-xs font-semibold">Take Photo</span>
          </button>
          <button
            onClick={handlePick}
            disabled={loading}
            className="flex flex-col items-center gap-2 py-4 bg-blue-50 border-2 border-dashed border-blue-300 rounded-2xl text-blue-600 tap-highlight disabled:opacity-50"
          >
            <span className="text-2xl">🖼️</span>
            <span className="text-xs font-semibold">Choose Photo</span>
          </button>
        </div>
      )}

      {loading && !displayUrl && (
        <p className="text-xs text-slate-400 text-center">Processing image...</p>
      )}
      {error && <p className="text-xs text-red-500 text-center">{error}</p>}
    </div>
  );
}
