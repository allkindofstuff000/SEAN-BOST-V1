import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  ClipboardList,
  Globe,
  Send,
  Settings as SettingsIcon,
  Timer,
  User,
  Bell
} from "lucide-react";
import { useAccounts } from "../context/AccountsContext";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import { getAppSettings, getTelegramSettings, updateAppSettings, detectTimezone } from "../lib/api";
import TelegramConfigModal from "../components/TelegramConfigModal";
import {
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEZONE_LABEL,
  DEFAULT_UI_TIME_FORMAT,
  formatDateTimeBDT
} from "../utils/timeDisplay";

const TIMEZONE_OPTIONS = [
  { value: "America/New_York", label: "New York (EST/EDT, UTC-5)", flag: "\ud83c\uddfa\ud83c\uddf8" },
  { value: "America/Chicago", label: "Texas / Chicago (CST/CDT, UTC-6)", flag: "\ud83c\uddfa\ud83c\uddf8" },
  { value: "America/Santo_Domingo", label: "Dominican Republic (AST, UTC-4)", flag: "\ud83c\udde9\ud83c\uddf4" },
  { value: "Asia/Dhaka", label: "Dhaka (BDT, UTC+6)", flag: "\ud83c\udde7\ud83c\udde9" },
  { value: "UTC", label: "Universal Time (UTC+0)", flag: "\ud83c\udf10" }
];

export default function Settings() {
  const navigate = useNavigate();
  const { showToast } = useAccounts();
  const { user, loading: authLoading } = useAuth();
  const { t } = useLanguage();

  const [telegramSettings, setTelegramSettings] = useState({
    enabled: false,
    chatId: "",
    tokenMasked: ""
  });
  const [loadingTelegram, setLoadingTelegram] = useState(true);
  const [telegramError, setTelegramError] = useState("");
  const [isTelegramModalOpen, setIsTelegramModalOpen] = useState(false);

  // Automation defaults — controlled state
  const [interval, setInterval_] = useState(30);
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [timezoneLabel, setTimezoneLabel] = useState(DEFAULT_TIMEZONE_LABEL);
  const [autoRestart, setAutoRestart] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);

  // Timezone detection
  const [detectedTz, setDetectedTz] = useState(null);
  const [detectingTz, setDetectingTz] = useState(true);

  const loadTelegramSettings = useCallback(async () => {
    setLoadingTelegram(true);
    setTelegramError("");
    try {
      const settings = await getTelegramSettings();
      setTelegramSettings({
        enabled: Boolean(settings?.enabled),
        chatId: String(settings?.chatId || ""),
        tokenMasked: String(settings?.tokenMasked || "")
      });
    } catch (error) {
      setTelegramError(
        error?.response?.data?.message || error?.message || "Failed to load Telegram settings"
      );
    } finally {
      setLoadingTelegram(false);
    }
  }, []);

  useEffect(() => { loadTelegramSettings(); }, [loadTelegramSettings]);

  // Load app settings + detect timezone
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await getAppSettings();
        const tz = String(settings?.timezone || DEFAULT_TIMEZONE);
        setTimezone(tz);
        setTimezoneLabel(String(settings?.timezoneLabel || DEFAULT_TIMEZONE_LABEL));
        setInterval_(Number(settings?.baseInterval) || 30);
      } catch {
        // keep defaults
      }
    };

    const detect = async () => {
      setDetectingTz(true);
      try {
        const result = await detectTimezone();
        if (result?.detected) {
          setDetectedTz(result);
        }
      } catch {
        // detection failed silently
      } finally {
        setDetectingTz(false);
      }
    };

    loadSettings();
    detect();
  }, []);

  const isConfigured = useMemo(
    () => Boolean(telegramSettings.enabled && telegramSettings.chatId),
    [telegramSettings]
  );

  const accountOverview = useMemo(
    () => ({
      username: authLoading ? "Loading..." : user?.username || "Unknown",
      userId: authLoading ? "Loading..." : String(user?._id || "Unknown").slice(0, 12) + "...",
      accountType: authLoading ? "Loading..." : formatRoleLabel(user?.role),
      memberSince: authLoading ? "Loading..." : formatMemberSince(user?.createdAt)
    }),
    [authLoading, user]
  );

  // Build dropdown options with auto-detected first
  const timezoneOptions = useMemo(() => {
    const options = [];

    if (detectedTz?.detected) {
      const alreadyInList = TIMEZONE_OPTIONS.some((opt) => opt.value === detectedTz.timezone);
      if (!alreadyInList) {
        options.push({
          value: detectedTz.timezone,
          label: `${detectedTz.label} (detected)`,
          flag: "\ud83c\udf10"
        });
      }
    }

    TIMEZONE_OPTIONS.forEach((opt) => {
      const isDetected = detectedTz?.detected && detectedTz.timezone === opt.value;
      options.push({
        ...opt,
        label: isDetected ? `${opt.label} (detected)` : opt.label
      });
    });

    return options;
  }, [detectedTz]);

  const handleTimezoneChange = (value) => {
    setTimezone(value);
    const matched = TIMEZONE_OPTIONS.find((opt) => opt.value === value);
    setTimezoneLabel(matched ? matched.label.replace(" (detected)", "") : value);
  };

  const handleSaveDefaults = async () => {
    if (saving) return;
    setSaving(true);
    setSaveResult(null);

    try {
      const result = await updateAppSettings({
        timezone,
        timezoneLabel,
        baseInterval: interval,
        autoRestart
      });

      const accountsUpdated = result?.accounts_updated || 0;
      const msg = accountsUpdated > 0
        ? `Settings saved. Timezone applied to ${accountsUpdated} accounts.`
        : "Settings saved.";
      showToast?.(msg, "success");
      setSaveResult({ accountsUpdated, time: new Date().toLocaleString() });
    } catch (error) {
      showToast?.(error?.message || "Failed to save settings", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pageShell" style={{ maxWidth: "900px", margin: "0 auto", width: "100%" }}>
      <h1 className="mb-2 flex items-center gap-2 text-2xl font-bold sm:text-3xl">
        <SettingsIcon size={28} />
        {t('settings.title')}
      </h1>

      {/* Account + Telegram side by side */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="themeCard p-5">
          <div className="mb-4 flex items-center gap-2">
            <User size={20} />
            <h2 className="text-lg font-semibold">{t('settings.account')}</h2>
          </div>
          <p className="mb-4 text-sm opacity-70">{t('settings.changeCredentials')}</p>
          <button className="themeBtnAccent rounded-lg px-4 py-2 text-sm font-medium sm:w-auto">
            {t('settings.manageAccount')}
          </button>
        </div>

        <div className="themeCard p-5">
          <div className="mb-4 flex items-center gap-2">
            <Send size={20} />
            <h2 className="text-lg font-semibold">{t('settings.telegramNotifications')}</h2>
          </div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm">{t('settings.enableTelegram')}</span>
            <TogglePill active={telegramSettings.enabled} />
          </div>
          {loadingTelegram ? (
            <p className="mb-4 text-xs opacity-60">Loading...</p>
          ) : (
            <div className="mb-4 space-y-1 text-sm opacity-80">
              <div>Bot Token: {telegramSettings.tokenMasked || t('settings.notConfigured')}</div>
              <div>Chat ID: <strong>{telegramSettings.chatId || t('settings.notConfigured')}</strong></div>
            </div>
          )}
          {telegramError ? (
            <p className="mb-4 rounded-md border border-red-500/40 bg-red-950/30 px-3 py-2 text-xs text-red-300">
              {telegramError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setIsTelegramModalOpen(true)}
            className="themeBtnAccent w-full rounded-lg px-4 py-2 text-sm font-medium"
          >
            {t('settings.configureTelegram')}
          </button>
        </div>
      </div>

      {/* Account Overview */}
      <div className="themeCard p-5">
        <div className="mb-4 flex items-center gap-2">
          <ClipboardList size={20} />
          <h2 className="text-lg font-semibold">{t('settings.accountOverview')}</h2>
        </div>
        <div className="grid grid-cols-2 gap-6 text-sm sm:grid-cols-4">
          <OverviewItem label={t('settings.username')} value={accountOverview.username} />
          <OverviewItem label={t('settings.userId')} value={accountOverview.userId} mono />
          <OverviewItem label={t('settings.accountType')} value={accountOverview.accountType} />
          <OverviewItem label={t('settings.memberSince')} value={accountOverview.memberSince} mono />
        </div>
      </div>

      {/* Automation Defaults */}
      <div className="themeCard p-5">
        <div className="mb-4 flex items-center gap-2">
          <Timer size={20} />
          <h2 className="text-lg font-semibold">{t('settings.automationDefaults')}</h2>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              {t('settings.defaultBaseInterval')}
            </label>
            <input
              type="number"
              min={1}
              value={interval}
              onChange={(e) => setInterval_(Math.max(1, Number(e.target.value) || 1))}
              className="themeField w-full rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              {t('settings.timezone')}
            </label>
            <select
              value={timezone}
              onChange={(e) => handleTimezoneChange(e.target.value)}
              className="themeField w-full rounded-lg px-3 py-2 text-sm"
            >
              {timezoneOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.flag} {opt.label}
                </option>
              ))}
            </select>
            {detectedTz?.detected && !detectingTz ? (
              <div className="mt-1.5 flex items-center gap-1 text-xs" style={{ color: "var(--muted)" }}>
                <Globe size={12} />
                {t('settings.autoDetected', { location: `${detectedTz.city || detectedTz.label}${detectedTz.country ? `, ${detectedTz.country}` : ""}` })}
              </div>
            ) : detectingTz ? (
              <div className="mt-1.5 text-xs" style={{ color: "var(--muted)" }}>{t('settings.detectingTimezone')}</div>
            ) : (
              <div className="mt-1.5 text-xs" style={{ color: "var(--muted)" }}>{t('settings.couldNotDetectTimezone')}</div>
            )}
          </div>

          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              {t('settings.autoRestartCrashed')}
            </label>
            <select
              value={autoRestart ? "enabled" : "disabled"}
              onChange={(e) => setAutoRestart(e.target.value === "enabled")}
              className="themeField w-full rounded-lg px-3 py-2 text-sm"
            >
              <option value="enabled">{t('settings.enabledDefault')}</option>
              <option value="disabled">{t('settings.disabled')}</option>
            </select>
          </div>
        </div>

        <p className="mt-2 text-xs" style={{ color: "var(--subtle)" }}>{t('settings.appliedToNewAccounts')}</p>

        <div className="mt-4 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={handleSaveDefaults}
            disabled={saving}
            className="themeBtnAccent rounded-lg px-6 py-2 text-sm font-medium disabled:opacity-60"
          >
            {saving ? t('settings.saving') : t('settings.saveDefaults')}
          </button>
        </div>

        {saveResult ? (
          <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: "var(--success)" }}>
            <CheckCircle2 size={14} />
            {t('settings.settingsSaved')}
            {saveResult.accountsUpdated > 0
              ? ` \u00b7 Timezone applied to ${saveResult.accountsUpdated} accounts`
              : ""}
            {` \u00b7 ${saveResult.time}`}
          </div>
        ) : null}
      </div>

      {/* Notification Events */}
      <div className="themeCard p-5">
        <div className="mb-4 flex items-center gap-2">
          <Bell size={20} />
          <h2 className="text-lg font-semibold">{t('settings.notificationEvents')}</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NotificationToggle label={t('settings.notifAccountCrashed')} defaultOn />
          <NotificationToggle label={t('settings.notifBumpExecuted')} />
          <NotificationToggle label={t('settings.notifAccountBanned')} defaultOn />
          <NotificationToggle label={t('settings.notifLicenseExpiring')} defaultOn />
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
            tokenMasked: String(updated?.tokenMasked || "")
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
  return formatDateTimeBDT(dateValue, {}, { fallback: "Unknown", includeSeconds: false });
}

function OverviewItem({ label, value, mono }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--subtle)" }}>{label}</div>
      <div className={`font-medium ${mono ? "mono text-sm" : ""}`}>{value}</div>
    </div>
  );
}

function TogglePill({ active }) {
  return (
    <div className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${active ? "bg-[var(--accent)]" : "bg-gray-600"}`}>
      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${active ? "translate-x-6" : "translate-x-1"}`} />
    </div>
  );
}

function NotificationToggle({ label, defaultOn = false }) {
  const [on, setOn] = useState(defaultOn);

  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--border)] p-3">
      <span className="text-sm">{label}</span>
      <button type="button" onClick={() => setOn((prev) => !prev)}>
        <div className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${on ? "bg-[var(--accent)]" : "bg-gray-600"}`}>
          <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
        </div>
      </button>
    </div>
  );
}
