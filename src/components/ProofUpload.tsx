"use client";

import { useState } from "react";
import { useCamera, useHaptics } from "@/hooks/useNative";

interface ProofUploadProps {
  onCapture: (hostedUrl: string) => void;
  currentProof?: string | null;
}

export default function ProofUpload({ onCapture, currentProof }: ProofUploadProps) {
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
      onCapture(data.url);
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

  // Prefer the already-uploaded proof; fall back to the local preview
  // while a fresh capture is still uploading.
  const displayUrl = currentProof || localPreview;
  const loading = cameraLoading || uploading;

  return (
    <div className="space-y-2">
      <label className="block text-sm font-semibold text-slate-700">
        📸 Payment Proof
      </label>

      {displayUrl ? (
        <div className="relative rounded-2xl overflow-hidden border border-slate-200">
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
