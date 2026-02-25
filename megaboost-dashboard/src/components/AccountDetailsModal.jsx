import { useEffect, useMemo, useState } from "react";
import { ArrowRight, LoaderCircle, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getAccountActivity, getAccountBumps, getAccountById } from "../lib/api";
import "./AccountDetailsModal.css";

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

function formatProxy(account) {
  if (!account?.proxyHost || !account?.proxyPort) return "Not configured";
  const base = `${account.proxyHost}:${account.proxyPort}`;
  return account.proxyUsername ? `${base} (auth)` : base;
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

export default function AccountDetailsModal({ account, onClose }) {
  const navigate = useNavigate();
  const [details, setDetails] = useState(account || null);
  const [activity, setActivity] = useState([]);
  const [bumpStats, setBumpStats] = useState({ total: toNumber(account?.totalBumpsToday, 0), items: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!account?._id) return;

    let active = true;

    Promise.allSettled([
      getAccountById(account._id),
      getAccountActivity(account._id),
      getAccountBumps(account._id)
    ])
      .then(([accountResult, activityResult, bumpsResult]) => {
        if (!active) return;

        if (accountResult.status === "fulfilled" && accountResult.value) {
          setDetails((previous) => ({ ...(previous || {}), ...accountResult.value }));
        }

        if (activityResult.status === "fulfilled") {
          setActivity(normalizeActivity(activityResult.value).slice(0, 3));
        } else {
          setActivity([]);
        }

        if (bumpsResult.status === "fulfilled") {
          const normalized = normalizeBumps(bumpsResult.value);
          setBumpStats(normalized);
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
  }, [account?._id]);

  const resolved = useMemo(() => ({ ...(account || {}), ...(details || {}) }), [account, details]);
  const accountId = resolved?._id || account?._id;
  const latestBumps = (bumpStats.items || []).slice(0, 5);
  const randomMin = toNumber(resolved?.randomMin, 0);
  const randomMax = toNumber(resolved?.randomMax, 10);
  const lastStatusChange = resolved?.statusChangedAt || resolved?.statusChanged || resolved?.updatedAt;
  const lastBumpAt = resolved?.lastBumpAt || resolveBumpTime(latestBumps[0]);

  if (!account) return null;

  return (
    <div className="account-details-modal-overlay" onClick={onClose}>
      <div className="account-details-modal" onClick={(event) => event.stopPropagation()}>
        <div className="adm-header">
          <div>
            <h2>Account Details</h2>
            <p>{resolved?.email || "Unknown account"}</p>
          </div>
          <button type="button" className="adm-close-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="adm-content">
          <div className="adm-grid-two">
            <section className="adm-card">
              <h3>Account Information</h3>
              <p><span>Email:</span> {resolved?.email || "-"}</p>
              <p><span>ID:</span> {accountId || "-"}</p>
              <p><span>Created:</span> {formatDateTime(resolved?.createdAt)}</p>
            </section>

            <section className="adm-card">
              <h3>Status Information</h3>
              <p><span>Status:</span> {resolved?.status || "stopped"}</p>
              <p><span>Last Change:</span> {formatDateTime(lastStatusChange, "N/A")}</p>
              <p><span>Last Bump:</span> {formatDateTime(lastBumpAt, "N/A")}</p>
            </section>
          </div>

          <div className="adm-grid-two">
            <section className="adm-card">
              <h3>Proxy Configuration</h3>
              <p>{formatProxy(resolved)}</p>
            </section>

            <section className="adm-card">
              <h3>Settings</h3>
              <p>
                <span>Auto-restart:</span> {resolved?.autoRestartCrashed === false ? "Disabled" : "Enabled"}
              </p>
            </section>
          </div>

          <section className="adm-card">
            <h3>Runtime Configuration</h3>
            <div className="adm-runtime-grid">
              <div className="adm-runtime-tile">
                <label>Base Interval</label>
                <strong>{toNumber(resolved?.baseInterval, 30)}min</strong>
              </div>
              <div className="adm-runtime-tile">
                <label>Random Range</label>
                <strong>{randomMin}-{randomMax}min</strong>
              </div>
              <div className="adm-runtime-tile">
                <label>Runtime Window</label>
                <strong>{resolved?.runtimeWindow || "00:00-23:59"}</strong>
              </div>
              <div className="adm-runtime-tile">
                <label>Max Daily Runtime</label>
                <strong>{toNumber(resolved?.maxDailyRuntime, 24)}h</strong>
              </div>
            </div>
          </section>

          <section className="adm-card">
            <h3>User Agent</h3>
            <pre className="adm-user-agent">{resolved?.userAgent || "No user agent configured."}</pre>
          </section>

          <div className="adm-grid-two">
            <section className="adm-card">
              <h3>Recent Activity</h3>
              {activity.length === 0 ? (
                <p className="adm-empty">No recent activity</p>
              ) : (
                <ul className="adm-list">
                  {activity.map((item, index) => {
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

            <section className="adm-card">
              <h3>Bump Stats</h3>
              <p><span>Total Bumps:</span> {toNumber(bumpStats.total, 0)}</p>
              {latestBumps.length === 0 ? (
                <p className="adm-empty">No bumps yet</p>
              ) : (
                <ul className="adm-list">
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
        </div>

        <div className="adm-footer">
          {loading ? (
            <span className="adm-loading">
              <LoaderCircle size={14} className="animate-spin" />
              Loading latest details...
            </span>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="adm-view-btn"
            onClick={() => {
              if (!accountId) return;
              onClose?.();
              navigate(`/accounts/details/${accountId}`, { state: { account: resolved } });
            }}
          >
            View Details
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
