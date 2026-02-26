import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  FileText,
  Send,
  Settings as SettingsIcon,
  User
} from "lucide-react";
import { useAccounts } from "../context/AccountsContext";
import { useAuth } from "../context/AuthContext";
import { getTelegramSettings } from "../lib/api";
import TelegramConfigModal from "../components/TelegramConfigModal";

export default function Settings() {
  const navigate = useNavigate();
  const { showToast } = useAccounts();
  const { user, loading: authLoading } = useAuth();

  const [telegramSettings, setTelegramSettings] = useState({
    enabled: false,
    chatId: "",
    hasTokenConfigured: false
  });
  const [loadingTelegram, setLoadingTelegram] = useState(true);
  const [telegramError, setTelegramError] = useState("");
  const [isTelegramModalOpen, setIsTelegramModalOpen] = useState(false);

  const loadTelegramSettings = useCallback(async () => {
    setLoadingTelegram(true);
    setTelegramError("");

    try {
      const settings = await getTelegramSettings();
      setTelegramSettings({
        enabled: Boolean(settings?.enabled),
        chatId: String(settings?.chatId || ""),
        hasTokenConfigured: Boolean(settings?.hasTokenConfigured)
      });
    } catch (error) {
      setTelegramError(
        error?.response?.data?.message ||
          error?.message ||
          "Failed to load Telegram settings"
      );
    } finally {
      setLoadingTelegram(false);
    }
  }, []);

  useEffect(() => {
    loadTelegramSettings();
  }, [loadTelegramSettings]);

  const isConfigured = useMemo(
    () => Boolean(telegramSettings.enabled && telegramSettings.chatId && telegramSettings.hasTokenConfigured),
    [telegramSettings]
  );

  const accountOverview = useMemo(
    () => ({
      username: authLoading ? "Loading..." : user?.username || "Unknown",
      userId: authLoading ? "Loading..." : String(user?._id || "Unknown"),
      accountType: authLoading ? "Loading..." : formatRoleLabel(user?.role),
      memberSince: authLoading ? "Loading..." : formatMemberSince(user?.createdAt)
    }),
    [authLoading, user]
  );

  return (
    <div>
      <h1 className="mb-8 flex items-center gap-2 text-2xl font-bold sm:text-3xl">
        <SettingsIcon size={28} />
        Settings
      </h1>

      <div className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-red-800 bg-card p-6">
          <div className="mb-4 flex items-center gap-2">
            <User size={20} />
            <h2 className="text-lg font-semibold">Account</h2>
          </div>

          <p className="mb-4 text-sm opacity-70">
            Change username and password
          </p>

          <button className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium transition hover:scale-105 sm:w-auto">
            Manage Account
          </button>
        </div>

        <div className="rounded-xl border border-red-800 bg-card p-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2">
              <Send size={20} />
              <h2 className="text-lg font-semibold">Telegram</h2>
            </div>
            {isConfigured ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-green-500/50 bg-green-900/30 px-2 py-0.5 text-xs font-semibold text-green-300">
                <CheckCircle2 size={12} />
                Configured
              </span>
            ) : null}
          </div>

          <p className="mb-2 text-sm opacity-70">
            Configure chat and command access (token comes from env)
          </p>

          {loadingTelegram ? (
            <p className="mb-4 text-xs opacity-60">Loading Telegram settings...</p>
          ) : (
            <div className="mb-4 space-y-1 text-xs opacity-80">
              <div>Chat ID: {telegramSettings.chatId || "Not set"}</div>
              <div>Token: {telegramSettings.hasTokenConfigured ? "Configured (env)" : "Not configured"}</div>
              <div>Status: {telegramSettings.enabled ? "Enabled" : "Disabled"}</div>
            </div>
          )}

          {telegramError ? (
            <p className="mb-4 rounded-md border border-red-700 bg-red-950/70 px-3 py-2 text-xs text-red-200">
              {telegramError}
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => setIsTelegramModalOpen(true)}
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium transition hover:scale-105 sm:w-auto"
          >
            Configure Telegram
          </button>
        </div>
      </div>

      <div className="mb-8 rounded-xl border border-red-800 bg-card p-6">
        <h2 className="mb-6 text-lg font-semibold">
          Quick Overview
        </h2>

        <div className="grid grid-cols-1 gap-8 text-sm lg:grid-cols-2 lg:gap-12">
          <div>
            <h3 className="mb-4 font-semibold">
              Account Information
            </h3>

            <InfoRow label="Username:" value={accountOverview.username} />
            <InfoRow label="User ID:" value={accountOverview.userId} />
            <InfoRow label="Account Type:" value={accountOverview.accountType} />
            <InfoRow label="Member Since:" value={accountOverview.memberSince} />
          </div>

          <div>
            <h3 className="mb-4 font-semibold">
              Telegram Status
            </h3>

            <StatusRow
              label="Telegram Bot:"
              value={isConfigured ? "Configured" : "Not Configured"}
              success={isConfigured}
            />
            <StatusRow
              label="Chat ID:"
              value={telegramSettings.chatId ? "Set" : "Not Set"}
              success={Boolean(telegramSettings.chatId)}
            />
            <InfoRow
              label="Token:"
              value={telegramSettings.hasTokenConfigured ? "Configured (env)" : "Not configured"}
            />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-red-800 bg-card p-6">
        <h2 className="mb-6 text-lg font-semibold">
          Additional Settings
        </h2>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="rounded-lg border border-red-800 bg-red-950 p-6">
            <h3 className="mb-3 font-semibold">
              Bumping Settings
            </h3>

            <p className="mb-4 text-sm opacity-70">
              Configure bumping intervals and runtime
            </p>

            <button
              onClick={() => navigate("/accounts/bumping")}
              className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium transition hover:scale-105 sm:w-auto"
            >
              Open Bumping Settings
            </button>
          </div>

          <div className="rounded-lg border border-red-800 bg-red-950 p-6">
            <h3 className="mb-3 flex items-center gap-2 font-semibold">
              <FileText size={18} />
              Activity Logs
            </h3>

            <p className="mb-4 text-sm opacity-70">
              View full account activity history
            </p>

            <button
              onClick={() => navigate("/activity")}
              className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium transition hover:scale-105 sm:w-auto"
            >
              View Activity History
            </button>
          </div>
        </div>
      </div>

      <TelegramConfigModal
        isOpen={isTelegramModalOpen}
        settings={telegramSettings}
        onClose={() => setIsTelegramModalOpen(false)}
        onSaved={(updated) => {
          setTelegramSettings({
            enabled: Boolean(updated?.enabled),
            chatId: String(updated?.chatId || ""),
            hasTokenConfigured: Boolean(updated?.hasTokenConfigured)
          });
        }}
        showToast={showToast}
      />
    </div>
  );
}

function formatRoleLabel(roleValue) {
  const normalized = String(roleValue || "").trim().toLowerCase();
  if (!normalized) return "Unknown";
  if (normalized === "admin") return "Admin";
  if (normalized === "user") return "User";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function formatMemberSince(dateValue) {
  const date = new Date(dateValue || "");
  if (Number.isNaN(date.valueOf())) {
    return "Unknown";
  }

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function InfoRow({ label, value }) {
  return (
    <div className="mb-2 flex justify-between gap-4">
      <span className="opacity-70">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function StatusRow({ label, value, success }) {
  return (
    <div className="mb-2 flex justify-between gap-4">
      <span className="opacity-70">{label}</span>
      <span className={`text-right font-medium ${success ? "text-green-400" : "text-red-300"}`}>
        {success ? "OK" : "-"} {value}
      </span>
    </div>
  );
}

