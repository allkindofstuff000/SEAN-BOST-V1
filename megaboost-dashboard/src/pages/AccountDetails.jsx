import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Edit3, LoaderCircle, Play, RotateCcw } from "lucide-react";
import { useAccounts } from "../context/AccountsContext";
import { getAccountActivity, getAccountBumps, getAccountById } from "../lib/api";
import { isRunningLikeStatus, toStatusClass } from "../utils/accountStatus";
import "./AccountDetails.css";

function formatDateTime(value, fallback = "-") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return fallback;
  return date.toLocaleString();
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatProxyAuth(account) {
  if (!account?.proxyHost || !account?.proxyPort) return "Not configured";
  const base = `${account.proxyHost}:${account.proxyPort}`;
  return account.proxyUsername ? `${base} (auth configured)` : base;
}

function normalizeActivity(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.logs)) return payload.logs;
  return [];
}

function resolveBumpTime(item) {
  return (
    item?.createdAt ||
    item?.bumpedAt ||
    item?.timestamp ||
    item?.date ||
    item?.time ||
    null
  );
}

function normalizeBumps(payload) {
  if (Array.isArray(payload)) {
    return { total: payload.length, items: payload };
  }

  if (!payload || typeof payload !== "object") {
    return { total: 0, items: [] };
  }

  const items = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.bumps)
      ? payload.bumps
      : Array.isArray(payload?.items)
        ? payload.items
        : [];

  const total = toNumber(payload.total ?? payload.totalBumps ?? payload.count, items.length);
  return { total, items };
}

function normalizeStatusClass(status) {
  return toStatusClass(status);
}

export default function AccountDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    accounts,
    startAccount,
    restartAccount,
    isAccountPending,
    showToast
  } = useAccounts();

  const stateAccount = location.state?.account;

  const accountFromContext = useMemo(
    () => accounts.find((account) => account._id === id) || null,
    [accounts, id]
  );

  const fallbackAccount = useMemo(() => {
    if (accountFromContext) return accountFromContext;
    if (stateAccount && (!id || stateAccount._id === id)) return stateAccount;
    return null;
  }, [accountFromContext, id, stateAccount]);

  const [accountData, setAccountData] = useState(fallbackAccount);
  const [activity, setActivity] = useState([]);
  const [bumpStats, setBumpStats] = useState({ total: toNumber(fallbackAccount?.totalBumpsToday, 0), items: [] });
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState("");

  useEffect(() => {
    if (!fallbackAccount) return;
    setAccountData((previous) => ({ ...(previous || {}), ...fallbackAccount }));
  }, [fallbackAccount]);

  useEffect(() => {
    if (!id) return;

    let active = true;
    setLoading(true);

    Promise.allSettled([
      getAccountById(id),
      getAccountActivity(id),
      getAccountBumps(id)
    ])
      .then(([accountResult, activityResult, bumpsResult]) => {
        if (!active) return;

        if (accountResult.status === "fulfilled" && accountResult.value) {
          setAccountData((previous) => ({ ...(previous || {}), ...accountResult.value }));
        } else {
          setAccountData((previous) => previous || { _id: id, email: "Unknown account" });
        }

        if (activityResult.status === "fulfilled") {
          setActivity(normalizeActivity(activityResult.value));
        } else {
          setActivity([]);
        }

        if (bumpsResult.status === "fulfilled") {
          setBumpStats(normalizeBumps(bumpsResult.value));
        } else {
          setBumpStats({ total: 0, items: [] });
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [id]);

  const refreshAccountFromApi = useCallback(async () => {
    if (!id) return;
    try {
      const latest = await getAccountById(id);
      if (latest) {
        setAccountData((previous) => ({ ...(previous || {}), ...latest }));
      }
    } catch {
      // fallback data already shown
    }
  }, [id]);

  const handleStart = useCallback(async () => {
    if (!id) return;

    setActionLoading("start");
    try {
      const result = await startAccount(id);
      if (result) {
        showToast("Start account request queued", "success");
      }
      await refreshAccountFromApi();
    } finally {
      setActionLoading("");
    }
  }, [id, refreshAccountFromApi, showToast, startAccount]);

  const handleRestart = useCallback(async () => {
    if (!id) return;

    setActionLoading("restart");
    try {
      const result = await restartAccount(id);
      if (result) {
        showToast("Restart requested", "success");
      }
      await refreshAccountFromApi();
    } catch (apiError) {
      showToast(`Restart failed: ${apiError.response?.data?.message || apiError.message}`, "error");
    } finally {
      setActionLoading("");
    }
  }, [id, refreshAccountFromApi, restartAccount, showToast]);

  const resolved = accountData || fallbackAccount || { _id: id };
  const email = resolved?.email || "Unknown account";
  const statusClass = normalizeStatusClass(resolved?.status);
  const busy = Boolean(isAccountPending(id)) || actionLoading !== "";
  const latestActivity = activity.slice(0, 8);
  const bumpItems = bumpStats.items || [];
  const latestBumps = bumpItems.slice(0, 10);
  const randomMin = toNumber(resolved?.randomMin, 0);
  const randomMax = toNumber(resolved?.randomMax, 10);
  const isRunning = isRunningLikeStatus(resolved?.status);
  const statusChangedAt = resolved?.statusChangedAt || resolved?.statusChanged || resolved?.updatedAt;

  return (
    <div className="account-details-page">
      <div className="account-details-breadcrumb">
        <Link to="/">Dashboard</Link>
        <span>&gt;</span>
        <Link to="/accounts/list">Accounts</Link>
        <span>&gt;</span>
        <span className="current">{email}</span>
      </div>

      <header className="account-details-header">
        <div>
          <h1>Account Details</h1>
          <p>Detailed information for {email}</p>
        </div>

        <button
          type="button"
          className="account-details-edit-btn"
          disabled
          title="Edit flow is not available yet"
        >
          <Edit3 size={16} />
          Edit Account
        </button>
      </header>

      <div className="account-details-layout">
        <div className="account-details-left">
          <section className="account-details-card">
            <h2>Account Information</h2>
            <div className="account-details-fields">
              <div><span>Email</span><strong>{email}</strong></div>
              <div><span>ID</span><strong>{resolved?._id || "-"}</strong></div>
              <div>
                <span>Status</span>
                <strong>
                  <span className={`adp-status-badge adp-status-${statusClass}`}>
                    {resolved?.status || "stopped"}
                  </span>
                </strong>
              </div>
              <div><span>Auto-restart</span><strong>{resolved?.autoRestartCrashed === false ? "Disabled" : "Enabled"}</strong></div>
              <div><span>Created</span><strong>{formatDateTime(resolved?.createdAt)}</strong></div>
              <div><span>Last Updated</span><strong>{formatDateTime(resolved?.updatedAt, "N/A")}</strong></div>
              <div><span>Last Bump</span><strong>{formatDateTime(resolved?.lastBumpAt, "N/A")}</strong></div>
              <div><span>Status Changed</span><strong>{formatDateTime(statusChangedAt, "N/A")}</strong></div>
            </div>
          </section>

          <section className="account-details-card">
            <h2>Proxy Settings</h2>
            <div className="account-details-fields">
              <div><span>Host</span><strong>{resolved?.proxyHost || "-"}</strong></div>
              <div><span>Port</span><strong>{resolved?.proxyPort || "-"}</strong></div>
              <div><span>Username</span><strong>{resolved?.proxyUsername || "Not set"}</strong></div>
              <div><span>Auth</span><strong>{resolved?.proxyUsername ? "Configured" : "Not configured"}</strong></div>
              <div className="adp-full"><span>Proxy</span><strong>{formatProxyAuth(resolved)}</strong></div>
            </div>
          </section>

          <section className="account-details-card">
            <h2>Browser Settings</h2>
            <pre className="account-details-ua">{resolved?.userAgent || "No user agent configured."}</pre>
          </section>

          <section className="account-details-card">
            <h2>Recent Activity</h2>
            {latestActivity.length === 0 ? (
              <p className="adp-empty">No recent activity</p>
            ) : (
              <ul className="adp-list">
                {latestActivity.map((item, index) => {
                  const key = item?._id || `${item?.createdAt || "activity"}-${index}`;
                  return (
                    <li key={key}>
                      <div>{item?.message || "Activity event"}</div>
                      <time>{formatDateTime(item?.createdAt || item?.timestamp, "-")}</time>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="account-details-card">
            <h2>Bump History</h2>
            <p className="adp-total">Total Bumps: {toNumber(bumpStats.total, 0)}</p>
            {latestBumps.length === 0 ? (
              <p className="adp-empty">No bumps yet</p>
            ) : (
              <ul className="adp-list">
                {latestBumps.map((item, index) => {
                  const key = item?._id || `${resolveBumpTime(item) || "bump"}-${index}`;
                  return (
                    <li key={key}>
                      <div>{item?.message || "Bump completed"}</div>
                      <time>{formatDateTime(resolveBumpTime(item), "-")}</time>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside className="account-details-right">
          <section className="account-details-card">
            <h2>Quick Actions</h2>
            <div className="adp-action-grid">
              <button
                type="button"
                className="adp-action-btn adp-primary"
                disabled={busy || isRunning}
                onClick={handleStart}
              >
                {actionLoading === "start" ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} />}
                {isRunning ? "Already Running" : "Start Account"}
              </button>

              <button
                type="button"
                className="adp-action-btn"
                disabled={busy}
                onClick={handleRestart}
              >
                {actionLoading === "restart" ? (
                  <LoaderCircle size={15} className="animate-spin" />
                ) : (
                  <RotateCcw size={15} />
                )}
                Restart Account
              </button>

              <button type="button" className="adp-action-btn" disabled title="Edit route not available">
                <Edit3 size={15} />
                Edit Account
              </button>
            </div>
          </section>

          <section className="account-details-card">
            <h2>Runtime Config</h2>
            <div className="account-details-fields">
              <div><span>Base Interval</span><strong>{toNumber(resolved?.baseInterval, 30)} min</strong></div>
              <div><span>Random Range</span><strong>{randomMin}-{randomMax} min</strong></div>
              <div><span>Runtime Window</span><strong>{resolved?.runtimeWindow || "00:00-23:59"}</strong></div>
              <div><span>Max Daily Runtime</span><strong>{toNumber(resolved?.maxDailyRuntime, 24)} h</strong></div>
            </div>
          </section>
        </aside>
      </div>

      {loading && (
        <div className="account-details-loading">
          <LoaderCircle size={15} className="animate-spin" />
          Loading latest details...
        </div>
      )}

      <button type="button" className="account-details-back-btn" onClick={() => navigate("/accounts/list")}>
        Back to Accounts
      </button>
    </div>
  );
}
