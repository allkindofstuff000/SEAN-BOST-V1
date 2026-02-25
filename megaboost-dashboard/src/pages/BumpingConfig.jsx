import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Clock,
  Play,
  Rocket,
  Square,
  Users
} from "lucide-react";
import { useAccounts } from "../context/AccountsContext";
import { applyBumpPreset, getBumpPresets } from "../lib/api";
import { isRunningLikeStatus } from "../utils/accountStatus";

const WINDOW_REGEX = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

const FALLBACK_PRESETS = [
  {
    key: "conservative",
    name: "Conservative",
    icon: "🐢",
    intervalLabel: "45min",
    baseInterval: 45,
    randomMin: 5,
    randomMax: 10,
    runtimeWindow: "00:00-23:59"
  },
  {
    key: "standard",
    name: "Standard",
    icon: "⚖️",
    intervalLabel: "30min",
    baseInterval: 30,
    randomMin: 3,
    randomMax: 7,
    runtimeWindow: "00:00-23:59"
  },
  {
    key: "aggressive",
    name: "Aggressive",
    icon: "🚀",
    intervalLabel: "15min",
    baseInterval: 15,
    randomMin: 0.5,
    randomMax: 3,
    runtimeWindow: "00:00-23:59"
  },
  {
    key: "business_hours",
    name: "Business Hours",
    icon: "🕐",
    intervalLabel: "9AM-5PM",
    baseInterval: 30,
    randomMin: 3,
    randomMax: 7,
    runtimeWindow: "09:00-17:00"
  }
];

const PRESET_THEME = {
  conservative: {
    border: "border-green-500",
    glow: "hover:shadow-[0_0_14px_rgba(34,197,94,0.25)]"
  },
  standard: {
    border: "border-cyan-500",
    glow: "hover:shadow-[0_0_14px_rgba(6,182,212,0.25)]"
  },
  aggressive: {
    border: "border-red-500",
    glow: "hover:shadow-[0_0_14px_rgba(239,68,68,0.25)]"
  },
  business_hours: {
    border: "border-yellow-500",
    glow: "hover:shadow-[0_0_14px_rgba(234,179,8,0.25)]"
  }
};

function normalizePresetList(serverPresets) {
  if (!Array.isArray(serverPresets) || serverPresets.length === 0) {
    return FALLBACK_PRESETS;
  }

  const fallbackByKey = new Map(FALLBACK_PRESETS.map((preset) => [preset.key, preset]));

  return serverPresets.map((preset) => {
    const key = String(preset.key || "").trim() || "standard";
    const fallback = fallbackByKey.get(key) || {};
    return {
      ...fallback,
      ...preset,
      key,
      icon: fallback.icon || "⚙️",
      intervalLabel: fallback.intervalLabel || `${preset.baseInterval || 30}min`,
      baseInterval: Number(preset.baseInterval ?? fallback.baseInterval ?? 30),
      randomMin: Number(preset.randomMin ?? fallback.randomMin ?? 0),
      randomMax: Number(preset.randomMax ?? fallback.randomMax ?? 5),
      runtimeWindow:
        String(preset.runtimeWindow ?? fallback.runtimeWindow ?? "00:00-23:59")
    };
  });
}

export default function BumpingConfig() {
  const {
    accounts,
    updateAccountSettings,
    showToast,
    queueState,
    fetchAccounts
  } = useAccounts();

  const [form, setForm] = useState({
    baseInterval: "30",
    randomMin: "3",
    randomMax: "7",
    runtimeWindow: "00:00-23:59",
    maxDailyRuntime: "8"
  });
  const [applyTo, setApplyTo] = useState("all");
  const [saving, setSaving] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [applyingPreset, setApplyingPreset] = useState("");
  const [presets, setPresets] = useState(FALLBACK_PRESETS);

  const stats = useMemo(() => {
    const bumping = accounts.filter((account) => account.status === "bumping").length;
    const active = accounts.filter((account) => isRunningLikeStatus(account.status)).length;
    const stopped = accounts.filter((account) => account.status === "stopped").length;

    return {
      total: accounts.length,
      bumping,
      active,
      stopped
    };
  }, [accounts]);

  const targetAccounts = useMemo(() => {
    if (applyTo === "all") return accounts;
    return accounts.filter((account) => account.status === "stopped");
  }, [accounts, applyTo]);

  const affectedLabel = useMemo(() => {
    if (applyTo === "all") return `all accounts (${targetAccounts.length})`;
    return `stopped accounts (${targetAccounts.length})`;
  }, [applyTo, targetAccounts.length]);

  useEffect(() => {
    let active = true;

    const loadPresets = async () => {
      try {
        const data = await getBumpPresets();
        if (!active) return;
        const normalized = normalizePresetList(data);
        setPresets(normalized);
      } catch {
        if (!active) return;
        setPresets(FALLBACK_PRESETS);
      }
    };

    loadPresets();
    return () => {
      active = false;
    };
  }, []);

  const setField = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    const baseInterval = Number(form.baseInterval);
    const randomMin = Number(form.randomMin);
    const randomMax = Number(form.randomMax);
    const maxDailyRuntime = Number(form.maxDailyRuntime);

    if (
      Number.isNaN(baseInterval) ||
      Number.isNaN(randomMin) ||
      Number.isNaN(randomMax) ||
      Number.isNaN(maxDailyRuntime)
    ) {
      showToast("All timing fields must be numeric", "error");
      return;
    }

    if (!WINDOW_REGEX.test(form.runtimeWindow)) {
      showToast("Runtime Window must match HH:MM-HH:MM", "error");
      return;
    }

    if (randomMax < randomMin) {
      showToast("Random Max must be >= Random Min", "error");
      return;
    }

    if (targetAccounts.length === 0) {
      showToast("No matching accounts for selected mode", "error");
      return;
    }

    const patch = {
      baseInterval,
      randomMin,
      randomMax,
      runtimeWindow: form.runtimeWindow,
      maxDailyRuntime
    };

    setSaving(true);
    try {
      const results = await Promise.allSettled(
        targetAccounts.map((account) => updateAccountSettings(account._id, patch))
      );

      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) {
        showToast(`Updated ${results.length - failed}/${results.length} accounts`, "error");
      } else {
        showToast(`Updated ${results.length} accounts`, "success");
      }
    } finally {
      setSaving(false);
    }
  };

  const applyPreset = async (presetKey) => {
    const preset = presets.find((item) => item.key === presetKey);
    if (!preset) {
      showToast("Preset not found", "error");
      return;
    }

    if (targetAccounts.length === 0) {
      showToast("No matching accounts for selected mode", "error");
      return;
    }

    const confirmed = window.confirm(
      `Apply ${preset.name} to ${affectedLabel}?`
    );
    if (!confirmed) return;

    setApplyingPreset(presetKey);
    try {
      const response = await applyBumpPreset(preset.key, applyTo);
      const payload = response?.data || {};
      const values = payload.values || {};

      setSelectedPreset(preset.key);
      setForm((prev) => ({
        ...prev,
        baseInterval: String(values.baseInterval ?? preset.baseInterval),
        randomMin: String(values.randomMin ?? preset.randomMin),
        randomMax: String(values.randomMax ?? preset.randomMax),
        runtimeWindow: String(values.runtimeWindow ?? preset.runtimeWindow)
      }));

      await fetchAccounts();
      showToast(
        response?.message ||
          `Applied ${preset.name} to ${payload.modifiedCount ?? targetAccounts.length} accounts`,
        "success"
      );
    } catch (error) {
      showToast(
        error?.response?.data?.message ||
          error.message ||
          "Failed to apply preset",
        "error"
      );
    } finally {
      setApplyingPreset("");
    }
  };

  return (
    <div className="pageInner">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Clock size={28} />
            Bumping Configuration
          </h1>

          <p className="opacity-70 mt-1">
            Configure bumping cadence and apply quick presets across accounts
          </p>
        </div>

        <Link
          to="/accounts/list"
          className="themeBtnMuted flex items-center gap-2 px-4 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Back to Accounts
        </Link>
      </div>

      <div className="bg-card themeBorder p-6 rounded-xl border shadow-md">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
          <SummaryStat icon={<Users size={20} />} label="Total Accounts" value={stats.total} />
          <SummaryStat icon={<Play size={20} className="text-cyan-400" />} label="Active" value={stats.active} />
          <SummaryStat icon={<Rocket size={20} className="text-red-400" />} label="Bumping" value={stats.bumping} />
          <SummaryStat icon={<Square size={20} className="text-gray-400" />} label="Stopped" value={stats.stopped} />
        </div>
      </div>

      <div className="bg-card themeBorder p-6 rounded-xl border shadow-md mt-8">
        <h2 className="text-xl font-semibold mb-1">Global Bumping Configuration</h2>

        <p className="opacity-70 text-sm mb-6">
          Queue pending: {queueState.totalPending} (running {queueState.running}, queued {queueState.queued})
        </p>

        <div className="mb-8">
          <h3 className="font-semibold mb-4">Apply Settings</h3>

          <div className="space-y-3 text-sm">
            <ApplyModeCard
              active={applyTo === "stopped"}
              title={`Apply to stopped accounts (${stats.stopped})`}
              subtitle="Safe to modify - accounts are not running"
              onClick={() => setApplyTo("stopped")}
            />

            <ApplyModeCard
              active={applyTo === "all"}
              title={`Apply to all accounts (${stats.total})`}
              subtitle="Will update running/active accounts"
              warning
              onClick={() => setApplyTo("all")}
            />
          </div>
        </div>

        <div className="mb-8">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="font-semibold">Quick Settings</h3>
            <p className="text-xs opacity-70">
              Affected: <span className="font-semibold">{affectedLabel}</span>
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {presets.map((preset) => {
              const theme = PRESET_THEME[preset.key] || PRESET_THEME.standard;
              const active = selectedPreset === preset.key;
              const loading = applyingPreset === preset.key;

              return (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => applyPreset(preset.key)}
                  disabled={Boolean(applyingPreset)}
                  className={`text-left bg-card p-4 rounded-xl border transition ${
                    active ? theme.border : "themeBorder"
                  } ${theme.glow} disabled:opacity-60 disabled:cursor-not-allowed`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm opacity-70">{preset.icon}</div>
                      <div className="font-semibold mt-1">{preset.name}</div>
                    </div>
                    <div className="text-xs opacity-70">
                      {loading ? "Applying..." : preset.intervalLabel}
                    </div>
                  </div>

                  <div className="text-xs opacity-70 mt-3">
                    Interval {preset.baseInterval}m, random {preset.randomMin}-{preset.randomMax}m
                  </div>
                  <div className="text-xs opacity-70 mt-1">
                    Window {preset.runtimeWindow}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mb-8">
          <h3 className="font-semibold mb-4">Timing Settings</h3>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <InputField
              label="Base Interval (minutes)"
              value={form.baseInterval}
              onChange={(value) => setField("baseInterval", value)}
              description="Time between bumps (1-1440 minutes)"
            />

            <InputField
              label="Random Min (minutes)"
              value={form.randomMin}
              onChange={(value) => setField("randomMin", value)}
              description="Random minimum delay added to base interval"
            />

            <InputField
              label="Random Max (minutes)"
              value={form.randomMax}
              onChange={(value) => setField("randomMax", value)}
              description="Random maximum delay added to base interval"
            />
          </div>
        </div>

        <div className="mb-8">
          <h3 className="font-semibold mb-4">Runtime Settings</h3>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <InputField
              label="Runtime Window"
              value={form.runtimeWindow}
              onChange={(value) => setField("runtimeWindow", value)}
              description="Format: HH:MM-HH:MM (example: 09:00-17:00)"
            />

            <InputField
              label="Max Daily Runtime (hours)"
              value={form.maxDailyRuntime}
              onChange={(value) => setField("maxDailyRuntime", value)}
              description="Maximum hours account can run per day"
            />
          </div>
        </div>

        <div className="flex justify-end gap-4 mt-6">
          <button
            type="button"
            onClick={() => setApplyTo("all")}
            className="themeBtnMuted px-5 py-2 text-sm"
          >
            Reset Mode
          </button>

          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="themeBtnAccent px-5 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving..." : "Save Custom Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryStat({ icon, label, value }) {
  return (
    <div className="bg-card themeBorder p-4 rounded-lg border hover:border-accent transition">
      <div className="flex items-center gap-2 opacity-70 text-sm mb-2">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function InputField({ label, value, onChange, description }) {
  return (
    <div>
      <label className="block text-sm mb-2 opacity-70">{label}</label>

      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="themeField w-full px-3 py-2 rounded-lg outline-none transition"
      />

      <p className="text-xs opacity-60 mt-2">{description}</p>
    </div>
  );
}

function ApplyModeCard({ active, title, subtitle, warning = false, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left bg-card p-4 rounded-lg border transition ${
        active ? "border-accent" : "themeBorder"
      }`}
    >
      <div className="font-medium">{title}</div>
      <div className={`${warning ? "text-yellow-400 text-xs mt-1" : "opacity-60"}`}>{subtitle}</div>
    </button>
  );
}
