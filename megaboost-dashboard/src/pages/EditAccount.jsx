import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import { useAccounts } from "../context/AccountsContext";
import { getAccountById, updateAccount } from "../lib/api";
import "./AddAccount.css";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

const USER_AGENTS = {
  "Chrome 120 (Windows)":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Chrome 120 (macOS)":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Firefox 121 (Windows)":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0"
};

const WINDOW_REGEX = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

function createInitialForm() {
  return {
    email: "",
    password: "",
    proxyHost: "",
    proxyPort: "8080",
    proxyUsername: "",
    proxyPassword: "",
    userAgent: DEFAULT_UA,
    autoRestartCrashed: true,
    baseInterval: "15",
    runtimeWindow: "00:00-23:59",
    randomMin: "0",
    randomMax: "5",
    maxDailyRuntime: "24"
  };
}

function mapAccountToForm(account) {
  if (!account) return createInitialForm();

  return {
    email: account.email || "",
    password: account.password || "",
    proxyHost: account.proxyHost || "",
    proxyPort: account.proxyPort != null ? String(account.proxyPort) : "8080",
    proxyUsername: account.proxyUsername || "",
    proxyPassword: account.proxyPassword || "",
    userAgent: account.userAgent || DEFAULT_UA,
    autoRestartCrashed: account.autoRestartCrashed !== false,
    baseInterval: account.baseInterval != null ? String(account.baseInterval) : "15",
    runtimeWindow: account.runtimeWindow || "00:00-23:59",
    randomMin: account.randomMin != null ? String(account.randomMin) : "0",
    randomMax: account.randomMax != null ? String(account.randomMax) : "5",
    maxDailyRuntime: account.maxDailyRuntime != null ? String(account.maxDailyRuntime) : "24"
  };
}

export default function EditAccount() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { accounts, accountLimit, usedAccounts, showToast, fetchAccounts } = useAccounts();

  const localAccount = useMemo(
    () => accounts.find((account) => String(account.id ?? account._id) === String(id)) || null,
    [accounts, id]
  );

  const [loadingAccount, setLoadingAccount] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState(() => mapAccountToForm(localAccount));

  useEffect(() => {
    let active = true;

    if (!id) {
      setFormError("Account ID is missing");
      setLoadingAccount(false);
      return () => {
        active = false;
      };
    }

    const loadAccount = async () => {
      setLoadingAccount(true);
      setFormError("");

      try {
        const account = await getAccountById(id);

        if (!active) return;

        if (!account) {
          setFormError("Account not found");
          return;
        }

        setForm(mapAccountToForm(account));
      } catch (apiError) {
        if (!active) return;
        setFormError(apiError.response?.data?.message || apiError.message || "Failed to load account");
      } finally {
        if (active) {
          setLoadingAccount(false);
        }
      }
    };

    loadAccount();

    return () => {
      active = false;
    };
  }, [id]);

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: "" }));
  };

  const applyQuickSetting = (type) => {
    const settings = {
      conservative: { baseInterval: "45", runtimeWindow: "00:00-23:59" },
      standard: { baseInterval: "30", runtimeWindow: "00:00-23:59" },
      aggressive: { baseInterval: "15", runtimeWindow: "00:00-23:59" },
      business: { baseInterval: "30", runtimeWindow: "09:00-17:00" }
    };

    setForm((prev) => ({ ...prev, ...settings[type] }));
    setErrors((prev) => ({ ...prev, baseInterval: "", runtimeWindow: "" }));
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
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError("");
    setSuccessMessage("");

    if (!id || !validate()) return;

    setSubmitting(true);

    try {
      await updateAccount(id, {
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

      setSuccessMessage("Account updated successfully.");
      showToast("Account updated", "success");
      await fetchAccounts();
      setTimeout(() => navigate("/accounts/list"), 600);
    } catch (apiError) {
      setFormError(apiError.response?.data?.message || apiError.message || "Failed to update account");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="add-account-page pageInner">
      <div className="add-account-breadcrumb">
        <Link to="/">Dashboard</Link>
        <span>&gt;</span>
        <Link to="/accounts/list">Accounts</Link>
        <span>&gt;</span>
        <span className="current">Edit Account</span>
      </div>

      <h1 className="add-account-title">Edit Account</h1>
      <p className="add-account-subtitle">Update your account configuration</p>
      {loadingAccount && <p className="hint">Loading account configuration...</p>}

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
          <Field label="User Agent *" error={errors.userAgent} hint="The user agent string for the browser simulation">
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
                value={form.randomMin}
                onChange={(e) => setField("randomMin", e.target.value)}
              />
            </Field>

            <Field label="Random Range Max (minutes)" error={errors.randomMax}>
              <input
                type="number"
                value={form.randomMax}
                onChange={(e) => setField("randomMax", e.target.value)}
              />
            </Field>

            <Field label="Max Daily Runtime (hours)" error={errors.maxDailyRuntime}>
              <input
                type="number"
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
            <button type="button" onClick={() => applyQuickSetting("business")}>Business Hours</button>
          </div>

          <p className="group-label">Common User Agents:</p>
          <div className="chip-row">
            {Object.entries(USER_AGENTS).map(([name, ua]) => (
              <button key={name} type="button" onClick={() => setField("userAgent", ua)}>{name}</button>
            ))}
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
          <button type="button" className="btn-cancel" onClick={() => navigate("/accounts/list")}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={submitting || loadingAccount}>
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                <LoaderCircle size={16} className="animate-spin" />
                Updating...
              </span>
            ) : (
              "Update Account"
            )}
          </button>
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
