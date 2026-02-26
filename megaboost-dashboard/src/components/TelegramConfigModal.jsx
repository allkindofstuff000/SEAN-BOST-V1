import { useEffect, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { updateTelegramSettings } from "../lib/api";

export default function TelegramConfigModal({
  isOpen,
  settings,
  onClose,
  onSaved,
  showToast
}) {
  const [chatId, setChatId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return;

    setChatId(String(settings?.chatId || ""));
    setEnabled(Boolean(settings?.enabled));
    setSaving(false);
    setError("");
  }, [isOpen, settings]);

  if (!isOpen) return null;

  const handleSave = async () => {
    if (saving) return;

    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      setError("Chat ID is required.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const updated = await updateTelegramSettings({
        enabled,
        chatId: trimmedChatId
      });
      onSaved?.(updated);
      showToast?.("Telegram settings saved", "success");
      onClose?.();
    } catch (saveError) {
      const message =
        saveError?.response?.data?.message ||
        saveError?.message ||
        "Failed to save Telegram settings";
      setError(message);
      showToast?.(message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-xl border border-red-800 bg-card p-6 shadow-[0_0_25px_rgba(255,59,59,0.22)]">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Configure Telegram</h2>
            <p className="mt-1 text-sm opacity-75">
              Control chat settings for Telegram pause/resume commands.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md p-1 text-white/80 hover:bg-white/10 disabled:opacity-60"
            aria-label="Close Telegram settings"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm opacity-90">Bot Token</label>
            <div className="rounded-lg border border-red-800 bg-red-950 px-3 py-2 text-sm">
              {settings?.hasTokenConfigured ? "Configured via env" : "Not configured"}
            </div>
            <p className="mt-2 text-xs opacity-70">
              Token is read from backend env (`TELEGRAM_BOT_TOKEN`) and is not stored in DB.
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm opacity-90">Chat ID</label>
            <input
              type="text"
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
              placeholder="-1001234567890"
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none transition focus:border-red-500"
            />
          </div>

          <label className="flex items-center justify-between rounded-lg border border-red-900/80 bg-red-950/40 px-3 py-2 text-sm">
            <span>Enable Telegram control</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="h-4 w-4 accent-red-500"
            />
          </label>

          {error ? (
            <div className="rounded-md border border-red-700 bg-red-950/70 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-600 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:scale-[1.01] disabled:opacity-60"
          >
            {saving ? <LoaderCircle size={14} className="animate-spin" /> : null}
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
