import { useState } from "react";
import { X } from "lucide-react";
import { useAccounts } from "../context/AccountsContext";
import TimePickerField from "./TimePickerField";
import {
  buildRuntimeWindowFromClockTimes,
  DEFAULT_TIMEZONE_LABEL,
  getRuntimeWindowClockRange
} from "../utils/timeDisplay";
import { TIMING_PRESETS_BY_KEY } from "../utils/timingPresets";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

const USER_AGENT_PRESETS = {
  "Chrome 120 (Windows)":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Chrome 120 (macOS)":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Firefox 121 (Windows)":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0"
};

export default function AddAccountModal({ onClose }) {
  const { addAccount, accountLimit, usedAccounts } = useAccounts();

  const [form, setForm] = useState({
    email: "",
    password: "",
    proxyHost: "",
    proxyPort: "8080",
    proxyUsername: "",
    proxyPassword: "",
    userAgent: DEFAULT_UA,
    autoRestartCrashed: true,
    baseInterval: 15,
    runFromTime: "12:00 AM",
    runToTime: "11:59 PM",
    randomMin: 0,
    randomMax: 5,
    maxDailyRuntime: 24
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const setField = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const applyQuickPreset = (presetKey) => {
    const preset = TIMING_PRESETS_BY_KEY[presetKey];
    if (!preset) return;
    const runtimeRange = getRuntimeWindowClockRange(preset.runtimeWindow);
    setForm((prev) => ({
      ...prev,
      baseInterval: preset.baseInterval,
      randomMin: preset.randomMin,
      randomMax: preset.randomMax,
      runFromTime: runtimeRange.start,
      runToTime: runtimeRange.end
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const runtimeWindow = buildRuntimeWindowFromClockTimes(form.runFromTime, form.runToTime);
      const runtimeRange = getRuntimeWindowClockRange(runtimeWindow);
      const payload = {
        email: form.email,
        password: form.password,
        proxyHost: form.proxyHost,
        proxyPort: Number(form.proxyPort),
        proxyUsername: form.proxyUsername,
        proxyPassword: form.proxyPassword,
        userAgent: form.userAgent,
        autoRestartCrashed: form.autoRestartCrashed,
        baseInterval: Number(form.baseInterval),
        baseIntervalMinutes: Number(form.baseInterval),
        runtimeWindow,
        runtimeStart: runtimeRange.start24h,
        runtimeEnd: runtimeRange.end24h,
        runtimeStartTime: form.runFromTime,
        runtimeEndTime: form.runToTime,
        randomMin: Number(form.randomMin),
        randomMinMinutes: Number(form.randomMin),
        randomMax: Number(form.randomMax),
        randomMaxMinutes: Number(form.randomMax),
        maxDailyRuntime: Number(form.maxDailyRuntime),
        maxDailyRuntimeHours: Number(form.maxDailyRuntime)
      };

      const result = await addAccount(payload);

      if (!result?.connectionTest?.success) {
        const reason = result?.connectionTest?.error || "Unknown connection error";
        alert(`Account saved, but proxy/site test failed: ${reason}`);
      }

      onClose();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to add account");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-50 p-4 overflow-y-auto">
      <div className="bg-card w-full max-w-3xl p-6 rounded-xl border border-red-800 shadow-xl">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-xl font-semibold">Add New Account</h2>
            <p className="text-sm opacity-70 mt-1">
              Add a new account to your MegaPersonals automation system
            </p>
            <p className="text-xs opacity-60 mt-2">
              Run times use {DEFAULT_TIMEZONE_LABEL}
            </p>
          </div>

          <button onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <section>
            <h3 className="font-semibold mb-3">Account Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Email Address *" hint="The email address for your MegaPersonals account">
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setField("email", e.target.value)}
                  placeholder="user@example.com"
                  required
                  className="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                />
              </Field>

              <Field label="Password *" hint="Password for your MegaPersonals account (minimum 6 characters)">
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setField("password", e.target.value)}
                  placeholder="Password"
                  minLength={6}
                  required
                  className="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                />
              </Field>
            </div>
          </section>

          <section>
            <h3 className="font-semibold mb-3">Proxy Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Proxy Host *">
                <input
                  value={form.proxyHost}
                  onChange={(e) => setField("proxyHost", e.target.value)}
                  placeholder="proxy.example.com"
                  required
                  className="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                />
              </Field>

              <Field label="Proxy Port *">
                <input
                  type="number"
                  value={form.proxyPort}
                  onChange={(e) => setField("proxyPort", e.target.value)}
                  placeholder="8080"
                  required
                  className="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                />
              </Field>

              <Field label="Proxy Username">
                <input
                  value={form.proxyUsername}
                  onChange={(e) => setField("proxyUsername", e.target.value)}
                  placeholder="Optional"
                  className="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                />
              </Field>

              <Field label="Proxy Password">
                <input
                  type="password"
                  value={form.proxyPassword}
                  onChange={(e) => setField("proxyPassword", e.target.value)}
                  placeholder="Optional"
                  className="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                />
              </Field>
            </div>
          </section>

          <section>
            <h3 className="font-semibold mb-3">Browser Settings</h3>
            <Field label="User Agent *" hint="The user agent string for the browser simulation">
              <textarea
                rows={3}
                value={form.userAgent}
                onChange={(e) => setField("userAgent", e.target.value)}
                required
                className="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
              />
            </Field>

            <p className="text-sm mb-2 opacity-80 mt-3">Common User Agents:</p>
            <div className="flex gap-2 mt-3 flex-wrap">
              {Object.entries(USER_AGENT_PRESETS).map(([label, value]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setField("userAgent", value)}
                  className="bg-gray-700 px-3 py-1 rounded text-xs"
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="font-semibold mb-3">Account Settings</h3>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={form.autoRestartCrashed}
                onChange={(e) => setField("autoRestartCrashed", e.target.checked)}
              />
              Auto-restart crashed accounts
            </label>
            <p className="opacity-70 text-xs mt-1">
              Automatically restart this account if it crashes
            </p>
          </section>

          <section>
            <h3 className="font-semibold mb-3">Bumping Configuration</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Base Interval (minutes)">
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={form.baseInterval}
                  onChange={(e) => setField("baseInterval", e.target.value)}
                  className="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                />
                <p className="text-xs opacity-70 mt-1">Time between bumps (1-1440 minutes)</p>
              </Field>

              <TimePickerField
                label="Run Account From"
                value={form.runFromTime}
                onChange={(value) => setField("runFromTime", value)}
                hint="Bangladesh time (UTC+6)"
                wrapperClassName="flex flex-col"
                labelClassName="mb-1.5 text-sm text-white/90"
                helperClassName="mt-1 text-xs text-white/60"
                selectClassName="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                rowClassName="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(96px,0.8fr)] gap-2 items-center max-sm:grid-cols-2"
                separatorClassName="text-lg opacity-70 text-center max-sm:hidden"
              />

              <TimePickerField
                label="Run Account To"
                value={form.runToTime}
                onChange={(value) => setField("runToTime", value)}
                hint="Bangladesh time (UTC+6)"
                wrapperClassName="flex flex-col"
                labelClassName="mb-1.5 text-sm text-white/90"
                helperClassName="mt-1 text-xs text-white/60"
                selectClassName="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                rowClassName="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(96px,0.8fr)] gap-2 items-center max-sm:grid-cols-2"
                separatorClassName="text-lg opacity-70 text-center max-sm:hidden"
              />

              <Field label="Random Range Min (minutes)">
                <input
                  type="number"
                  min={0}
                  value={form.randomMin}
                  onChange={(e) => setField("randomMin", e.target.value)}
                  className="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                />
              </Field>

              <Field label="Random Range Max (minutes)">
                <input
                  type="number"
                  min={0}
                  value={form.randomMax}
                  onChange={(e) => setField("randomMax", e.target.value)}
                  className="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                />
              </Field>

              <Field label="Max Daily Runtime (hours)" hint="Maximum hours account can run per day">
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={form.maxDailyRuntime}
                  onChange={(e) => setField("maxDailyRuntime", e.target.value)}
                  className="w-full bg-red-950 px-3 py-2 rounded-lg border border-red-800 outline-none focus:border-accent"
                />
              </Field>
            </div>

            <div className="mt-4">
              <p className="text-sm mb-2 opacity-80">Quick Settings:</p>
              <div className="flex gap-2 flex-wrap">
                <button type="button" className="bg-gray-700 px-3 py-1 rounded text-xs" onClick={() => applyQuickPreset("conservative")}>
                  Conservative (45min)
                </button>
                <button type="button" className="bg-gray-700 px-3 py-1 rounded text-xs" onClick={() => applyQuickPreset("standard")}>
                  Standard (30min)
                </button>
                <button type="button" className="bg-gray-700 px-3 py-1 rounded text-xs" onClick={() => applyQuickPreset("aggressive")}>
                  Aggressive (15min)
                </button>
                <button
                  type="button"
                  className="bg-gray-700 px-3 py-1 rounded text-xs"
                  onClick={() => applyQuickPreset("business_hours")}
                >
                  Business Hours
                </button>
              </div>
            </div>
          </section>

          {error && <div className="text-red-400 text-sm">{error}</div>}

          <section className="border border-red-800 rounded-lg p-4 bg-red-950/40">
            <h3 className="font-semibold mb-2">Account Limit Information</h3>
            <p className="text-sm opacity-80">
              You are currently using {usedAccounts} out of {accountLimit} accounts allowed by your license.
            </p>
          </section>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="bg-gray-600 px-4 py-2 rounded-lg text-sm"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={submitting}
              className="bg-accent px-4 py-2 rounded-lg text-sm font-medium"
            >
              {submitting ? "Adding..." : "Add Account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm mb-2 opacity-90">{label}</label>
      {children}
      {hint && <p className="text-xs opacity-70 mt-1">{hint}</p>}
    </div>
  );
}
