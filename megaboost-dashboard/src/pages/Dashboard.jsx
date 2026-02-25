import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { io } from "socket.io-client";
import {
  AlertTriangle,
  Ban,
  KeyRound,
  PauseCircle,
  Play,
  Shield,
  Square,
  Users,
  Settings as SettingsIcon,
  List as ListIcon
} from "lucide-react";
import StatCard from "../components/StatCard";
import api, { getSocketBaseUrl } from "../lib/api";
import { useAccounts } from "../context/AccountsContext";
import { useAuth } from "../context/AuthContext";
import { isRunningLikeStatus, toStatusClass } from "../utils/accountStatus";
import "./Dashboard.css";

function formatDisplayDate(dateValue) {
  if (!dateValue) return "N/A";

  const date = new Date(dateValue);
  if (Number.isNaN(date.valueOf())) return "N/A";

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function formatDateTime(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.valueOf())) return "-";
  return date.toLocaleString();
}

function normalizeStatusClass(status) {
  return toStatusClass(status);
}

function normalizeRecentLogsPayload(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function prependUniqueLog(logs, newLog, limit = 10) {
  if (!newLog || typeof newLog !== "object") {
    return logs.slice(0, limit);
  }

  const next = [newLog, ...logs.filter((item) => item?._id !== newLog?._id)];
  return next.slice(0, limit);
}

function getLicenseMessage(status) {
  if (status === "expired") return "License expired. Renew to continue account actions.";
  if (status === "revoked") return "License revoked. Contact admin to reactivate.";
  if (status === "no_license") return "No license assigned. Contact admin.";
  return "";
}

function getLicenseBadge(status) {
  if (status === "active") return { label: "Active", className: "licenseActiveBadge" };
  if (status === "expired") return { label: "Expired", className: "licenseDangerBadge" };
  if (status === "revoked") return { label: "Revoked", className: "licenseDangerBadge" };
  return { label: "No License", className: "licenseWarningBadge" };
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    accounts,
    accountLimit,
    licenseInfo,
    startAllAccounts,
    stopAllAccounts,
    showToast
  } = useAccounts();

  const [recentActivity, setRecentActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [quickActionLoading, setQuickActionLoading] = useState("");

  const fetchRecentActivity = useCallback(async () => {
    try {
      setActivityLoading(true);
      const response = await api.get("/api/logs/recent", { cache: "no-store" });
      const payload = response?.data;
      const items = normalizeRecentLogsPayload(payload);
      setRecentActivity(items.slice(0, 10));
    } catch (error) {
      console.error("Error fetching recent activity:", error);
      setRecentActivity([]);
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecentActivity();
  }, [fetchRecentActivity]);

  useEffect(() => {
    const socket = io(getSocketBaseUrl(), {
      withCredentials: true,
      transports: ["websocket", "polling"]
    });

    const handleNewLog = (newLog) => {
      setRecentActivity((prev) => prependUniqueLog(prev, newLog, 10));
    };

    socket.on("new-log", handleNewLog);
    socket.on("log:new", handleNewLog);

    return () => {
      socket.off("new-log", handleNewLog);
      socket.off("log:new", handleNewLog);
      socket.disconnect();
    };
  }, []);

  const stats = useMemo(() => {
    const computed = {
      total: accounts.length,
      running: 0,
      needs2fa: 0,
      banned: 0,
      paused: 0,
      stopped: 0,
      crashed: 0
    };

    accounts.forEach((account) => {
      if (isRunningLikeStatus(account.status)) computed.running += 1;
      if (account.status === "awaiting_2fa" || account.status === "awaiting_verification_code") {
        computed.needs2fa += 1;
      }
      if (account.status === "banned") computed.banned += 1;
      if (account.status === "paused") computed.paused += 1;
      if (account.status === "stopped") computed.stopped += 1;
      if (account.status === "crashed") computed.crashed += 1;
    });

    return computed;
  }, [accounts]);

  const licenseStatus = String(licenseInfo?.status || "no_license").toLowerCase();
  const licenseIsValid = licenseStatus === "active";
  const licenseBadge = getLicenseBadge(licenseStatus);
  const licenseMessage = getLicenseMessage(licenseStatus);

  const licenseLimitValue = useMemo(() => {
    const fromLicense = Number(licenseInfo?.limit);
    if (Number.isFinite(fromLicense) && fromLicense > 0) {
      return Math.floor(fromLicense);
    }

    const fallback = Number(accountLimit);
    if (Number.isFinite(fallback) && fallback > 0) {
      return Math.floor(fallback);
    }

    return 0;
  }, [accountLimit, licenseInfo?.limit]);

  const accountUsage = stats.total;
  const usagePercent = useMemo(() => {
    if (!licenseLimitValue) return 0;
    const ratio = (accountUsage / licenseLimitValue) * 100;
    return Number(Math.min(100, Math.max(0, ratio)).toFixed(1));
  }, [accountUsage, licenseLimitValue]);

  const recentAccounts = useMemo(() => {
    return [...accounts]
      .sort((a, b) => new Date(b.createdAt).valueOf() - new Date(a.createdAt).valueOf())
      .slice(0, 3);
  }, [accounts]);

  const handleStartAll = useCallback(async () => {
    if (!licenseIsValid) {
      showToast(licenseMessage || "License required / expired", "error");
      return;
    }

    setQuickActionLoading("start");
    try {
      await startAllAccounts(accounts);
      showToast("Start-all queued", "success");
    } catch (error) {
      console.error("Start-all failed", error);
    } finally {
      setQuickActionLoading("");
    }
  }, [accounts, licenseIsValid, licenseMessage, showToast, startAllAccounts]);

  const handleStopAll = useCallback(async () => {
    setQuickActionLoading("stop");
    try {
      await stopAllAccounts(accounts);
      showToast("Stop-all queued", "success");
    } catch (error) {
      console.error("Stop-all failed", error);
    } finally {
      setQuickActionLoading("");
    }
  }, [accounts, showToast, stopAllAccounts]);

  const handleAddAccount = useCallback(() => {
    if (!licenseIsValid) {
      showToast(licenseMessage || "License required / expired", "error");
      return;
    }
    navigate("/accounts/add");
  }, [licenseIsValid, licenseMessage, navigate, showToast]);

  const statCards = [
    { title: "Total Accounts", value: stats.total, icon: <Users size={18} className="text-red-300" /> },
    { title: "Running", value: stats.running, icon: <Play size={18} className="text-green-400" /> },
    { title: "Needs 2FA", value: stats.needs2fa, icon: <Shield size={18} className="text-blue-400" /> },
    { title: "Banned", value: stats.banned, icon: <Ban size={18} className="text-pink-400" /> },
    { title: "Paused", value: stats.paused, icon: <PauseCircle size={18} className="text-yellow-400" /> },
    { title: "Stopped", value: stats.stopped, icon: <Square size={18} className="text-gray-300" /> },
    { title: "Crashed", value: stats.crashed, icon: <AlertTriangle size={18} className="text-red-400" /> }
  ];

  return (
    <div className="dashboardPage w-full">
      <header className="dashboardHeader">
        <h1 className="dashboardTitle">Dashboard</h1>
        <p className="dashboardSubtitle">Welcome back, {user?.username || "User"}!</p>
      </header>

      <section className="dashboardCard licenseCard">
        <div className="licenseLeft">
          <div className="licenseHead">
            <KeyRound size={18} className="text-red-300" />
            <h2>License Status</h2>
          </div>

          <div className="licenseMetaRow">
            <span className={licenseBadge.className}>{licenseBadge.label}</span>
            <span className="licenseExpiry">Expires: {formatDisplayDate(licenseInfo?.expiresAt)}</span>
          </div>

          {!licenseIsValid ? (
            <p className="mt-2 text-sm text-red-300">{licenseMessage || "License required / expired"}</p>
          ) : null}
        </div>

        <div className="licenseRight">
          <div className="usageTopRow">
            <span>Account Usage</span>
            <strong>
              {accountUsage}/{licenseLimitValue || "-"}
            </strong>
          </div>

          <div className="usageProgress">
            <div className="usageProgressFill" style={{ width: `${usagePercent}%` }} />
          </div>

          <div className="usagePercentText">{usagePercent}% used</div>
        </div>
      </section>

      <section className="dashboardStatsGrid">
        {statCards.map((stat) => (
          <StatCard key={stat.title} title={stat.title} value={stat.value} icon={stat.icon} />
        ))}
      </section>

      <section className="dashboardMidGrid">
        <article className="dashboardCard">
          <div className="sectionHeader">
            <h3>Recent Activity</h3>
            <button className="inlineLink" onClick={() => navigate("/activity")} type="button">
              View All -&gt;
            </button>
          </div>

          <div className="activityList">
            {activityLoading && <div className="mutedLine">Loading activity...</div>}
            {!activityLoading && recentActivity.length === 0 && (
              <div className="mutedLine">No recent activity.</div>
            )}

            {!activityLoading &&
              recentActivity.map((item) => (
                <button
                  type="button"
                  key={item._id}
                  className="activityItem"
                  onClick={() => navigate("/activity")}
                >
                  <span className={`activityDot activityDot-${item.level || "info"}`} />
                  <span className="activityContent">
                    <span className="activityMessage">{item.message}</span>
                    <span className="activityTime">{formatDateTime(item.createdAt)}</span>
                  </span>
                </button>
              ))}
          </div>
        </article>

        <article className="dashboardCard">
          <div className="sectionHeader">
            <h3>Quick Actions</h3>
          </div>

          <div className="quickActions">
            <button
              type="button"
              className="quickBtn quickBtnPrimary"
              onClick={handleAddAccount}
              disabled={!licenseIsValid}
            >
              + Add Account
            </button>

            <div className="quickBtnRow">
              <button
                type="button"
                className="quickBtn"
                onClick={handleStartAll}
                disabled={quickActionLoading !== "" || !licenseIsValid}
              >
                {quickActionLoading === "start" ? "Starting..." : "Start All"}
              </button>

              <button
                type="button"
                className="quickBtn"
                onClick={handleStopAll}
                disabled={quickActionLoading !== ""}
              >
                {quickActionLoading === "stop" ? "Stopping..." : "Stop All"}
              </button>
            </div>

            <button
              type="button"
              className="quickBtn"
              onClick={() => navigate("/settings")}
            >
              <SettingsIcon size={14} />
              Settings
            </button>
          </div>
        </article>
      </section>

      <section className="dashboardCard recentAccountsCard">
        <div className="sectionHeader">
          <h3>Recent Accounts</h3>
        </div>

        <div className="recentAccountList">
          {recentAccounts.length === 0 && <div className="mutedLine">No accounts yet.</div>}

          {recentAccounts.map((account) => (
            <button
              key={account._id}
              type="button"
              className="recentAccountRow"
              onClick={() => navigate("/accounts/list")}
            >
              <div className="recentAccountLeft">
                <div className="recentEmail">{account.email}</div>
                <div className="recentCreated">Created: {formatDisplayDate(account.createdAt)}</div>
              </div>

              <span className={`recentStatus status-${normalizeStatusClass(account.status)}`}>
                {account.status || "stopped"}
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="viewAllAccountsBtn"
          onClick={() => navigate("/accounts/list")}
        >
          <ListIcon size={14} />
          View All Accounts -&gt;
        </button>
      </section>
    </div>
  );
}
