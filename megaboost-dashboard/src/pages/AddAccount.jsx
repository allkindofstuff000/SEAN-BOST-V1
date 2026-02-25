import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAccounts } from "../context/AccountsContext";
import "./AddAccount.css";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const USER_AGENTS = {
  "Chrome 120 (Windows)":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Chrome 120 (macOS)":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Firefox 121 (Windows)":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0"
};

const WINDOW_REGEX = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

export default function AddAccount() {
  const navigate = useNavigate();
  const { addAccount, accountLimit, usedAccounts } = useAccounts();

  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState({
    email: "",
    password: "",
    proxyHost: "",
    proxyPort: "8080",
    proxyUsername: "",
    proxyPassword: "",
    userAgent: DEFAULT_UA,
    autoRestartCrashed: true,
    baseInterval: "30",
    runtimeWindow: "00:00-23:59",
    randomMin: "0",
    randomMax: "5",
    maxDailyRuntime: "8"
  });

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: "" }));
  };

  const applyQuickSetting = (type) => {
    const settings = {
      conservative: {
        baseInterval: "45",
        randomMin: "5",
        randomMax: "10"
      },
      standard: {
        baseInterval: "30",
        randomMin: "3",
        randomMax: "7"
      },
      aggressive: {
        baseInterval: "15",
        randomMin: "1",
        randomMax: "3"
      },
      businessHours: {
        runtimeWindow: "09:00-17:00"
      }
    };

    setForm((prev) => ({ ...prev, ...settings[type] }));
    setErrors((prev) => ({
      ...prev,
      baseInterval: "",
      runtimeWindow: "",
      randomMin: "",
      randomMax: ""
    }));
  };

  const validate = () => {
    const nextErrors = {};

    if (!form.email.trim()) nextErrors.email = "Email Address is required";
    if (!form.password || form.password.length < 6) nextErrors.password = "Password must be at least 6 characters";
    if (!form.proxyHost.trim()) nextErrors.proxyHost = "Proxy Host is required";
    if (!form.proxyPort || Number.isNaN(Number(form.proxyPort))) nextErrors.proxyPort = "Proxy Port must be numeric";
    if (!form.userAgent.trim()) nextErrors.userAgent = "User Agent is required";

    if (form.baseInterval === "" || Number.isNaN(Number(form.baseInterval))) {
      nextErrors.baseInterval = "Base Interval must be numeric";
    } else if (Number(form.baseInterval) < 1 || Number(form.baseInterval) > 1440) {
      nextErrors.baseInterval = "Base Interval must be between 1 and 1440";
    }

    if (!WINDOW_REGEX.test(form.runtimeWindow)) {
      nextErrors.runtimeWindow = "Runtime Window must match HH:MM-HH:MM";
    }

    if (form.randomMin === "" || Number.isNaN(Number(form.randomMin))) {
      nextErrors.randomMin = "Random Range Min must be numeric";
    }

    if (form.randomMax === "" || Number.isNaN(Number(form.randomMax))) {
      nextErrors.randomMax = "Random Range Max must be numeric";
    }

    if (!nextErrors.randomMin && !nextErrors.randomMax && Number(form.randomMax) < Number(form.randomMin)) {
      nextErrors.randomMax = "Random Range Max must be greater than or equal to Random Range Min";
    }

    if (form.maxDailyRuntime === "" || Number.isNaN(Number(form.maxDailyRuntime))) {
      nextErrors.maxDailyRuntime = "Max Daily Runtime must be numeric";
    } else if (
      Number(form.maxDailyRuntime) < 1 ||
      Number(form.maxDailyRuntime) > 24
    ) {
      nextErrors.maxDailyRuntime = "Max Daily Runtime must be between 1 and 24";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError("");
    setSuccessMessage("");

    if (!validate()) return;

    setSubmitting(true);

    try {
      await addAccount({
        email: form.email.trim(),
        password: form.password,
        proxyHost: form.proxyHost.trim(),
        proxyPort: Number(form.proxyPort),
        proxyUsername: form.proxyUsername.trim(),
        proxyPassword: form.proxyPassword,
        userAgent: form.userAgent.trim(),
        autoRestartCrashed: form.autoRestartCrashed,
        baseInterval: Number(form.baseInterval),
        runtimeWindow: form.runtimeWindow,
        randomMin: Number(form.randomMin),
        randomMax: Number(form.randomMax),
        maxDailyRuntime: Number(form.maxDailyRuntime)
      });

      setSuccessMessage("Account created. Syncing with backend...");
      setTimeout(() => navigate("/accounts"), 1000);
    } catch (apiError) {
      setFormError(apiError.response?.data?.message || apiError.message || "Failed to add account");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="add-account-page pageInner">
      <div className="add-account-breadcrumb">
        <Link to="/">Dashboard</Link>
        <span>&gt;</span>
        <Link to="/accounts">Accounts</Link>
        <span>&gt;</span>
        <span className="current">Add Account</span>
      </div>

      <h1 className="add-account-title">Add New Account</h1>
      <p className="add-account-subtitle">Add a new account to your MegaPersonals automation system</p>

      <form className="add-account-form" onSubmit={handleSubmit}>
        <section className="add-card">
          <h2>Account Information</h2>
          <div className="field-grid">
            <Field label="Email Address *" error={errors.email} hint="The email address for your MegaPersonals account">
              <input
                type="email"
                placeholder="user@example.com"
                value={form.email}
                onChange={(e) => setField("email", e.target.value)}
              />
            </Field>

            <Field label="Password *" error={errors.password} hint="Password for your MegaPersonals account (minimum 6 characters)">
              <input
                type="password"
                placeholder="Password"
                minLength={6}
                value={form.password}
                onChange={(e) => setField("password", e.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="add-card">
          <h2>Proxy Settings</h2>
          <div className="field-grid">
            <Field label="Proxy Host *" error={errors.proxyHost}>
              <input
                placeholder="proxy.example.com"
                value={form.proxyHost}
                onChange={(e) => setField("proxyHost", e.target.value)}
              />
            </Field>

            <Field label="Proxy Port *" error={errors.proxyPort}>
              <input
                type="number"
                placeholder="8080"
                value={form.proxyPort}
                onChange={(e) => setField("proxyPort", e.target.value)}
              />
            </Field>

            <Field label="Proxy Username" error={errors.proxyUsername}>
              <input
                placeholder="Optional"
                value={form.proxyUsername}
                onChange={(e) => setField("proxyUsername", e.target.value)}
              />
            </Field>

            <Field label="Proxy Password" error={errors.proxyPassword}>
              <input
                type="password"
                placeholder="Optional"
                value={form.proxyPassword}
                onChange={(e) => setField("proxyPassword", e.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="add-card">
          <h2>Browser Settings</h2>
          <Field
            label="User Agent Profile"
            hint="Pick a common browser profile"
          >
            <select
              value={form.userAgent}
              onChange={(e) => setField("userAgent", e.target.value)}
            >
              {Object.entries(USER_AGENTS).map(([name, ua]) => (
                <option key={name} value={ua}>
                  {name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="User Agent *"
            error={errors.userAgent}
            hint="The user agent string for the browser simulation"
          >
            <textarea
              rows={3}
              value={form.userAgent}
              onChange={(e) => setField("userAgent", e.target.value)}
            />
          </Field>
        </section>

        <section className="add-card">
          <h2>Account Settings</h2>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.autoRestartCrashed}
              onChange={(e) => setField("autoRestartCrashed", e.target.checked)}
            />
            <span>Auto-restart crashed accounts</span>
          </label>
          <p className="hint">Automatically restart this account if it crashes</p>
        </section>

        <section className="add-card">
          <h2>Bumping Configuration</h2>
          <div className="field-grid">
            <Field label="Base Interval (minutes)" error={errors.baseInterval} hint="Time between bumps (1-1440 minutes)">
              <input
                type="number"
                min={1}
                max={1440}
                value={form.baseInterval}
                onChange={(e) => setField("baseInterval", e.target.value)}
              />
            </Field>

            <Field label="Runtime Window" error={errors.runtimeWindow} hint="Format: HH:MM-HH:MM">
              <input
                value={form.runtimeWindow}
                onChange={(e) => setField("runtimeWindow", e.target.value)}
              />
            </Field>

            <Field label="Random Range Min (minutes)" error={errors.randomMin}>
              <input
                type="number"
                min={0}
                max={60}
                value={form.randomMin}
                onChange={(e) => setField("randomMin", e.target.value)}
              />
            </Field>

            <Field label="Random Range Max (minutes)" error={errors.randomMax}>
              <input
                type="number"
                min={0}
                max={60}
                value={form.randomMax}
                onChange={(e) => setField("randomMax", e.target.value)}
              />
            </Field>

            <Field label="Max Daily Runtime (hours)" error={errors.maxDailyRuntime}>
              <input
                type="number"
                min={1}
                max={24}
                value={form.maxDailyRuntime}
                onChange={(e) => setField("maxDailyRuntime", e.target.value)}
              />
            </Field>
          </div>

          <p className="group-label">Quick Settings:</p>
          <div className="chip-row">
            <button type="button" onClick={() => applyQuickSetting("conservative")}>Conservative (45min)</button>
            <button type="button" onClick={() => applyQuickSetting("standard")}>Standard (30min)</button>
            <button type="button" onClick={() => applyQuickSetting("aggressive")}>Aggressive (15min)</button>
            <button type="button" onClick={() => applyQuickSetting("businessHours")}>Business Hours</button>
          </div>
        </section>

        <section className="add-card limit-card">
          <h2>Account Limit Information</h2>
          <p>
            You are currently using {usedAccounts} out of {accountLimit} accounts allowed by your license.
          </p>
        </section>

        {formError && <p className="form-error">{formError}</p>}
        {successMessage && <p className="form-success">{successMessage}</p>}

        <div className="actions-row">
          <button type="button" className="btn-cancel" onClick={() => navigate("/accounts")}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={submitting}>{submitting ? "Adding..." : "Add Account"}</button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, hint, error, children }) {
  return (
    <div className="field-block">
      <label>{label}</label>
      {children}
      {hint ? <p className="hint">{hint}</p> : null}
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}
