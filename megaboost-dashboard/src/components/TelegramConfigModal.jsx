import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, LoaderCircle, Send, X } from "lucide-react";
import {
  testTelegramSettings,
  updateTelegramSettings
} from "../lib/api";

function hasConfiguredToken(maskedToken) {
  return Boolean(String(maskedToken || "").trim());
}

export default function TelegramConfigModal({
  isOpen,
  settings,
  onClose,
  onSaved,
  showToast
}) {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return;

    const tokenMasked = String(settings?.tokenMasked || "");
    const incomingChatId = String(settings?.chatId || "");
    const hasExistingConfig = hasConfiguredToken(tokenMasked) || Boolean(incomingChatId);
    const incomingEnabled =
      typeof settings?.enabled === "boolean"
        ? settings.enabled
        : hasExistingConfig
          ? false
          : true;

    setBotToken("");
    setChatId(incomingChatId);
    setEnabled(hasExistingConfig ? incomingEnabled : true);
    setShowToken(false);
    setSaving(false);
    setTesting(false);
    setError("");
  }, [isOpen, settings]);

  const maskedToken = useMemo(
    () => String(settings?.tokenMasked || ""),
    [settings?.tokenMasked]
  );

  if (!isOpen) return null;

  const handleSave = async () => {
    if (saving) return;

    const trimmedToken = botToken.trim();
    const trimmedChatId = chatId.trim();

    if (enabled && !trimmedChatId) {
      setError("Chat ID is required when Telegram is enabled.");
      return;
    }

    if (enabled && !trimmedToken && !maskedToken) {
      setError("Bot token is required when Telegram is enabled.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const payload = {
        enabled,
        chatId: trimmedChatId
      };

      if (trimmedToken) {
        payload.botToken = trimmedToken;
      }

      const updated = await updateTelegramSettings(payload);
      onSaved?.(updated);
      showToast?.("Telegram settings saved", "success");
      onClose?.();
    } catch (saveError) {
      const message =
        saveError?.response?.data?.message ||
        saveError?.message ||
        "Failed to save Telegram settings";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (testing) return;
    setTesting(true);
    setError("");

    try {
      const response = await testTelegramSettings();
      if (response?.ok) {
        showToast?.("Telegram test message sent", "success");
      } else {
        showToast?.("Telegram test failed", "error");
      }
    } catch (testError) {
      const message =
        testError?.response?.data?.message ||
        testError?.message ||
        "Failed to send Telegram test";
      setError(message);
      showToast?.(message, "error");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-xl border border-red-800 bg-card p-6 shadow-[0_0_25px_rgba(255,59,59,0.22)]">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Configure Telegram</h2>
            <p className="mt-1 text-sm opacity-75">
              Save your bot token and chat ID for event notifications.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving || testing}
            className="rounded-md p-1 text-white/80 hover:bg-white/10 disabled:opacity-60"
            aria-label="Close Telegram settings"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm opacity-90">
              Bot Token
            </label>
            <div className="relative">
              <input
                type={showToken ? "text" : "password"}
                value={botToken}
                onChange={(event) => setBotToken(event.target.value)}
                placeholder={maskedToken ? "Enter new token to replace" : "123456:ABC..."}
                autoComplete="new-password"
                className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 pr-10 outline-none transition focus:border-red-500"
              />
              <button
                type="button"
                onClick={() => setShowToken((value) => !value)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-white/75 hover:bg-white/10"
                aria-label={showToken ? "Hide token" : "Show token"}
              >
                {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {maskedToken ? (
              <p className="mt-2 text-xs text-green-300/85">
                Configured token: {maskedToken}
              </p>
            ) : (
              <p className="mt-2 text-xs opacity-70">
                Token is never returned in full.
              </p>
            )}
          </div>

          <div>
            <label className="mb-2 block text-sm opacity-90">
              Chat ID
            </label>
            <input
              type="text"
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
              placeholder="-1001234567890"
              className="w-full rounded-lg border border-red-800 bg-red-950 px-3 py-2 outline-none transition focus:border-red-500"
            />
          </div>

          <label className="flex items-center justify-between rounded-lg border border-red-900/80 bg-red-950/40 px-3 py-2 text-sm">
            <span>Enable Telegram notifications</span>
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
            disabled={saving || testing}
            className="rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-600 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={saving || testing}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-900/30 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-800/35 disabled:opacity-60"
          >
            {testing ? <LoaderCircle size={14} className="animate-spin" /> : <Send size={14} />}
            {testing ? "Sending..." : "Send Test"}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || testing}
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
