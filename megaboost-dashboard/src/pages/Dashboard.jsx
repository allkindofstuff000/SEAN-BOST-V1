import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Ban,
  KeyRound,
  PauseCircle,
  Play,
  Shield,
  Square,
  Users,
} from "lucide-react";
import StatCard from "../components/StatCard";
import api from "../lib/api";
import { useAccounts } from "../context/AccountsContext";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import { isRunningLikeStatus, toStatusClass } from "../utils/accountStatus";
import { formatDateBDT } from "../utils/timeDisplay";
import "./Dashboard.css";

function formatDisplayDate(dateValue) {
  return formatDateBDT(dateValue, {}, { fallback: "N/A" });
}

function normalizeStatusClass(status) {
  return toStatusClass(status);
}

function getLicenseBadge(status) {
  if (status === "active") return { labelKey: "dashboard.activeLicense", className: "licenseActiveBadge" };
  if (status === "expired") return { labelKey: "dashboard.expiredLicense", className: "licenseDangerBadge" };
  if (status === "revoked") return { labelKey: "dashboard.revokedLicense", className: "licenseDangerBadge" };
  return { labelKey: "dashboard.noLicense", className: "licenseWarningBadge" };
}

function maskLicenseKey(key) {
  if (!key) return "—";
  const raw = String(key);
  if (raw.length <= 8) return raw;
  return raw.slice(0, 7) + "****-" + raw.slice(-4);
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useLanguage();
  const {
    accounts,
    accountLimit,
    licenseInfo,
  } = useAccounts();

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
  const licenseBadge = getLicenseBadge(licenseStatus);

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

  const recentAccounts = useMemo(() => {
    return [...accounts]
      .sort((a, b) => new Date(b.createdAt).valueOf() - new Date(a.createdAt).valueOf())
      .slice(0, 4);
  }, [accounts]);

  const statCards = [
    { title: t('dashboard.totalAccounts'), value: stats.total, icon: <Users size={18} className="text-gray-300" /> },
    { title: t('status.running'), value: stats.running, icon: <Play size={18} className="text-green-400" /> },
    { title: t('status.needs2fa'), value: stats.needs2fa, icon: <Shield size={18} className="text-blue-400" /> },
    { title: t('status.banned'), value: stats.banned, icon: <Ban size={18} className="text-pink-400" /> },
    { title: t('status.paused'), value: stats.paused, icon: <PauseCircle size={18} className="text-yellow-400" /> },
    { title: t('status.stopped'), value: stats.stopped, icon: <Square size={18} className="text-gray-300" /> },
    { title: t('status.crashed'), value: stats.crashed, icon: <AlertTriangle size={18} className="text-red-400" /> }
  ];

  return (
    <div className="dashboardPage w-full">
      <header className="dashboardHeader">
        <h1 className="dashboardTitle">{t('dashboard.title')}</h1>
        <p className="dashboardSubtitle">{t('dashboard.welcome', { name: user?.username || "User" })}</p>
      </header>

      <section className="dashboardCard licenseCard">
        <div className="licenseLeft">
          <div className="licenseHead">
            <KeyRound size={18} className="text-[var(--accent)]" />
            <h2>{t('dashboard.licenseStatus')}</h2>
          </div>

          <div className="licenseMetaRow">
            <span className={licenseBadge.className}>{t(licenseBadge.labelKey)}</span>
            <span className="licenseExpiry">{t('dashboard.expires')}: {formatDisplayDate(licenseInfo?.expiresAt)}</span>
          </div>

          <div className="licenseKeyRow">
            {t('dashboard.key')}: <strong>{maskLicenseKey(licenseInfo?.key)}</strong>
            {" · "}{t('dashboard.maxAccounts')}: <span className="text-green-400">{licenseLimitValue || "—"}</span>
            {" · "}{t('dashboard.used')}: {stats.total}
          </div>
        </div>

        <div className="licenseActions">
          <button
            type="button"
            className="themeBtnAccent licenseActionBtn"
            onClick={() => navigate("/accounts/list")}
          >
            {t('dashboard.goToAccounts')}
          </button>
          <button
            type="button"
            className="themeBtnMuted licenseActionBtn"
            onClick={() => navigate("/activity")}
          >
            {t('nav.activityLogs')}
          </button>
          <button
            type="button"
            className="themeBtnMuted licenseActionBtn"
            onClick={() => navigate("/settings")}
          >
            {t('nav.settings')}
          </button>
        </div>
      </section>

      <section className="dashboardStatsGrid">
        {statCards.map((stat) => (
          <StatCard key={stat.title} title={stat.title} value={stat.value} icon={stat.icon} />
        ))}
      </section>

      <section className="dashboardCard recentAccountsCard">
        <div className="sectionHeader">
          <h3>{t('dashboard.recentAccounts')}</h3>
        </div>

        <div className="recentAccountList">
          {recentAccounts.length === 0 && <div className="mutedLine">{t('dashboard.noAccountsYet')}</div>}

          {recentAccounts.map((account) => (
            <button
              key={account._id}
              type="button"
              className="recentAccountRow"
              onClick={() => navigate("/accounts/list")}
            >
              <div className="recentAccountLeft">
                <div className="recentEmail">{account.email}</div>
                <div className="recentCreated">{t('dashboard.created')}: {formatDisplayDate(account.createdAt)}</div>
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
          {t('dashboard.viewAllAccounts')} &rarr;
        </button>
      </section>
    </div>
  );
}
