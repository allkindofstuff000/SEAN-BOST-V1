import { useCallback, useState } from "react";
import { LoaderCircle, Shield } from "lucide-react";
import api from "../lib/api";

export default function VerificationModal({ account, onSuccess, onClose }) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorMeta, setErrorMeta] = useState(null);

  const submitCode = useCallback(async () => {
    if (code.length !== 4 || loading) return;

    setLoading(true);
    setError("");
    setErrorMeta(null);

    try {
      try {
        await api.post(
          `/api/accounts/${account._id}/verification`,
          { code },
          { timeoutMs: 45000 }
        );
      } catch (verificationError) {
        if (verificationError.status === 404) {
          await api.post(
            `/api/accounts/${account._id}/2fa`,
            { code },
            { timeoutMs: 45000 }
          );
        } else {
          throw verificationError;
        }
      }

      await onSuccess?.();
    } catch (submitError) {
      const payload = submitError?.response?.data || null;
      const message = payload?.message || submitError.message || "Failed to submit 2FA code";
      setError(message);
      setErrorMeta({
        code: payload?.code || null,
        hint: payload?.hint || null,
        url: payload?.url || null,
        title: payload?.title || null,
        screenshotPath:
          payload?.screenshotPath || payload?.diagnostics?.screenshotPath || null,
        htmlPath: payload?.htmlPath || payload?.diagnostics?.htmlPath || null,
        screenshotUrl:
          payload?.screenshotUrl || payload?.diagnostics?.screenshotUrl || null,
        htmlUrl: payload?.htmlUrl || payload?.diagnostics?.htmlUrl || null
      });
      console.error("2FA submit failed", submitError);
    } finally {
      setLoading(false);
    }
  }, [account._id, code, loading, onSuccess]);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      await submitCode();
    },
    [submitCode]
  );

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[9999] p-4">
      <div className="w-full max-w-md rounded-xl border border-cyan-400/40 bg-[#1f2937] shadow-[0_0_18px_rgba(0,207,255,0.35)] p-6">
        <h2 className="text-white text-2xl mb-2 text-center inline-flex items-center justify-center gap-2 w-full">
          <Shield size={20} className="text-cyan-300" />
          Enter 2FA Code
        </h2>

        <p className="text-cyan-200/80 text-center mb-4">{account.email}</p>

        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="0000"
            autoFocus
            inputMode="numeric"
            className="w-full p-4 text-3xl text-center tracking-[0.7em] bg-[#374151] text-white border border-cyan-500/40 rounded-lg mb-3"
          />

          {error && (
            <div className="text-red-300 text-sm mb-3 space-y-1">
              <div>{error}</div>
              {errorMeta?.code ? <div className="text-xs opacity-85">Code: {errorMeta.code}</div> : null}
              {errorMeta?.hint ? <div className="text-xs opacity-85">Hint: {errorMeta.hint}</div> : null}
              {errorMeta?.url ? <div className="text-xs opacity-70">URL: {errorMeta.url}</div> : null}
              {errorMeta?.title ? <div className="text-xs opacity-70">Title: {errorMeta.title}</div> : null}
              {errorMeta?.screenshotPath ? (
                <div className="text-xs opacity-85">Diagnostics screenshot: {errorMeta.screenshotPath}</div>
              ) : null}
              {errorMeta?.htmlPath ? (
                <div className="text-xs opacity-85">Diagnostics HTML: {errorMeta.htmlPath}</div>
              ) : null}
              {errorMeta?.screenshotUrl ? (
                <a
                  href={errorMeta.screenshotUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-300 underline text-xs inline-block"
                >
                  View diagnostics screenshot
                </a>
              ) : null}
              {errorMeta?.htmlUrl ? (
                <a
                  href={errorMeta.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-300 underline text-xs inline-block ml-3"
                >
                  View diagnostics HTML
                </a>
              ) : null}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2 rounded-lg bg-gray-600 text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitCode}
              disabled={code.length !== 4 || loading}
              className="flex-1 px-4 py-2 rounded-lg bg-slate-600 text-white disabled:opacity-50"
            >
              Retry Submit
            </button>

            <button
              type="submit"
              disabled={code.length !== 4 || loading}
              className="flex-1 px-4 py-2 rounded-lg bg-cyan-600 text-white font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {loading ? <LoaderCircle size={16} className="animate-spin" /> : null}
              {loading ? "Submitting..." : "Submit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
