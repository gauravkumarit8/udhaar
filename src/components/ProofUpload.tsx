"use client";

import { useCamera, useHaptics } from "@/hooks/useNative";

interface ProofUploadProps {
  onCapture: (dataUrl: string) => void;
  currentProof?: string | null;
}

export default function ProofUpload({ onCapture, currentProof }: ProofUploadProps) {
  const { photoUrl, loading, capture, pick, clear } = useCamera();
  const haptics = useHaptics();

  const handleCapture = async () => {
    haptics.tap();
    const result = await capture();
    if (result) onCapture(result);
  };

  const handlePick = async () => {
    haptics.tap();
    const result = await pick();
    if (result) onCapture(result);
  };

  const displayUrl = currentProof || photoUrl;

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
          <button
            onClick={() => {
              clear();
              onCapture("");
            }}
            className="absolute top-2 right-2 w-8 h-8 bg-red-500 text-white rounded-full flex items-center justify-center text-sm shadow-lg tap-highlight"
          >
            ✕
          </button>
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

      {loading && (
        <p className="text-xs text-slate-400 text-center">Processing image...</p>
      )}
    </div>
  );
}
