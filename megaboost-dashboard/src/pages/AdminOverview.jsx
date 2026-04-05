import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { KeyRound, Users, AlertTriangle, ShieldCheck, UserCircle, Shield } from "lucide-react";
import { adminGetOverview, adminListUsers, adminListLicenses } from "../lib/api";
import { useAccounts } from "../context/AccountsContext";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";

function AdminTabs() {
  const { t } = useLanguage();
  const tabs = [
    { to: "/admin", label: t('admin.overview'), end: true },
    { to: "/admin/users", label: t('admin.users') },
    { to: "/admin/licenses", label: t('admin.licenses') }
  ];

  return (
    <nav className="adminTabs">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            `adminTab ${isActive ? "active" : ""}`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}

function OverviewCard({ title, value, icon }) {
  return (
    <div className="themeCard p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm" style={{ color: "var(--muted)" }}>{title}</span>
        {icon}
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
    </div>
  );
}

function RoleBadge({ role }) {
  const isAdmin = role === "admin";
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{
        background: isAdmin ? "rgba(6,182,212,0.15)" : "rgba(107,114,128,0.2)",
        color: isAdmin ? "#06b6d4" : "#9ca3af",
        border: `1px solid ${isAdmin ? "rgba(6,182,212,0.35)" : "rgba(107,114,128,0.3)"}`
      }}
    >
      {role}
    </span>
  );
}

function StatusPill({ label, color }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{
        background: `${color}22`,
        color: color,
        border: `1px solid ${color}55`
      }}
    >
      {label}
    </span>
  );
}

function maskKey(key) {
  const value = String(key || "").trim().toUpperCase();
  const match = value.match(/^([A-Z0-9]+)-([A-F0-9]{4})-([A-F0-9]{4})-([A-F0-9]{4})$/);
  if (!match) return value;
  return `${match[1]}-${match[2]}-****-${match[4]}`;
}

export default function AdminOverview() {
  const navigate = useNavigate();
  const { showToast, accounts } = useAccounts();
  const { isAdmin } = useAuth();
  const { t } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [overview, setOverview] = useState({
    totalUsers: 0,
    totalLicenses: 0,
    activeLicenses: 0,
    expiringSoon: 0
  });
  const [users, setUsers] = useState([]);
  const [licenses, setLicenses] = useState([]);

  useEffect(() => {
    let mounted = true;

    const loadAll = async () => {
      setLoading(true);
      setError("");
      try {
        const [overviewData, usersData, licensesData] = await Promise.all([
          adminGetOverview(),
          adminListUsers({ page: 1, limit: 10 }).catch(() => ({ data: [] })),
          adminListLicenses({ page: 1, limit: 10, status: "all" }).catch(() => ({ data: [] }))
        ]);

        if (!mounted) return;
        setOverview({
          totalUsers: Number(overviewData?.totalUsers || 0),
          totalLicenses: Number(overviewData?.totalLicenses || 0),
          activeLicenses: Number(overviewData?.activeLicenses || 0),
          expiringSoon: Number(overviewData?.expiringSoon || 0)
        });
        setUsers(Array.isArray(usersData?.data) ? usersData.data : []);
        setLicenses(Array.isArray(licensesData?.data) ? licensesData.data : []);
      } catch (loadError) {
        if (!mounted) return;
        const message =
          loadError?.response?.data?.message ||
          loadError?.message ||
          "Failed to load admin overview";
        setError(message);
        showToast?.(message, "error");
      } finally {
        if (mounted) setLoading(false);
      }
    };

    loadAll();
    return () => { mounted = false; };
  }, [showToast]);

  const activeLicenseCount = licenses.filter((l) => l.status === "active").length;
  const expiredLicenseCount = licenses.filter((l) => l.status === "expired").length;
  const expiringCount = overview.expiringSoon;

  const runningWorkers = accounts.filter((a) => a.status === "running" || a.status === "bumping").length;

  return (
    <div className="space-y-5" style={{ maxWidth: "1400px", margin: "0 auto", width: "100%" }}>
      <AdminTabs />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">{t('admin.title')}</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>{t('admin.subtitle')}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewCard title={t('admin.totalUsers')} value={loading ? "-" : overview.totalUsers} icon={<Users size={18} className="text-cyan-300" />} />
        <OverviewCard title={t('admin.totalLicenses')} value={loading ? "-" : overview.totalLicenses} icon={<KeyRound size={18} className="text-yellow-300" />} />
        <OverviewCard title={t('admin.activeLicenses')} value={loading ? "-" : overview.activeLicenses} icon={<ShieldCheck size={18} className="text-green-300" />} />
        <OverviewCard title={t('admin.expiringIn7Days')} value={loading ? "-" : overview.expiringSoon} icon={<AlertTriangle size={18} className="text-red-300" />} />
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : null}

      <div className="themeCard p-5">
        <h2 className="mb-4 text-lg font-semibold">{t('admin.quickActions')}</h2>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => navigate("/admin/licenses")} className="themeBtnTeal rounded-lg px-4 py-2 text-sm font-semibold">
            {t('admin.createLicense')}
          </button>
          <button type="button" onClick={() => navigate("/admin/users")} className="themeBtnPink rounded-lg px-4 py-2 text-sm font-semibold">
            {t('admin.createUser')}
          </button>
          <button type="button" onClick={() => navigate("/admin/users")} className="themeBtnMuted rounded-lg px-4 py-2 text-sm font-semibold">
            {t('admin.manageUsers')} &rarr;
          </button>
          <button type="button" onClick={() => navigate("/admin/licenses")} className="themeBtnMuted rounded-lg px-4 py-2 text-sm font-semibold">
            {t('admin.manageLicenses')} &rarr;
          </button>
        </div>
      </div>

      {/* Two-column: Registered Users + License Keys */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Registered Users */}
        <div className="themeCard p-5">
          <div className="mb-4 flex items-center gap-2">
            <Users size={18} className="text-cyan-300" />
            <h2 className="text-lg font-semibold">{t('admin.registeredUsers')}</h2>
          </div>

          <div className="space-y-1">
            {users.map((user) => (
              <div key={user._id} className="flex items-center justify-between rounded-lg border border-[var(--border)] p-3">
                <div className="flex items-center gap-3 min-w-0">
                  <UserCircle size={20} style={{ color: "var(--muted)" }} />
                  <div className="min-w-0">
                    <div className="font-semibold text-sm truncate">{user.username}</div>
                    <div className="text-xs truncate" style={{ color: "var(--muted)" }}>{user.email}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <RoleBadge role={user.role} />
                  {user.isActive === false && <StatusPill label="inactive" color="#ef4444" />}
                </div>
              </div>
            ))}
            {users.length === 0 && !loading && (
              <div className="text-sm py-4 text-center" style={{ color: "var(--muted)" }}>{t('admin.noUsersFound')}</div>
            )}
          </div>
        </div>

        {/* License Keys */}
        <div className="themeCard p-5">
          <div className="mb-4 flex items-center gap-2">
            <KeyRound size={18} className="text-yellow-300" />
            <h2 className="text-lg font-semibold">{t('admin.licenseKeys')}</h2>
          </div>

          <div className="space-y-2">
            {licenses.map((license) => {
              const isExpired = license.status === "expired";
              const displayKey = String(license.keyMasked || maskKey(license.key));
              const expiresDate = license.expiresAt ? new Date(license.expiresAt).toLocaleDateString() : "N/A";

              return (
                <div key={license._id} className="rounded-lg border border-[var(--border)] p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-sm mono">{displayKey}</span>
                    <StatusPill
                      label={license.status === "active" ? "Active" : "Expired"}
                      color={license.status === "active" ? "#22c55e" : "#ef4444"}
                    />
                  </div>
                  <div className="text-xs mono" style={{ color: "var(--muted)" }}>
                    Max: <span className="text-green-400">{license.maxAccounts}</span> accs
                    {" · "}Expires: <span style={{ color: isExpired ? "#ef4444" : "inherit" }}>{expiresDate}</span>
                    {license.notes ? ` · ${license.notes}` : ""}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Summary row */}
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="rounded-lg p-3 text-center" style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)" }}>
              <div className="text-lg font-bold text-green-400">{activeLicenseCount}</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>{t('status.active')}</div>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)" }}>
              <div className="text-lg font-bold text-red-400">{expiredLicenseCount}</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>{t('status.expired')}</div>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: "rgba(234,179,8,0.12)", border: "1px solid rgba(234,179,8,0.3)" }}>
              <div className="text-lg font-bold text-yellow-400">{expiringCount}</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>{t('status.expiring')}</div>
            </div>
          </div>
        </div>
      </div>

      {/* System Health */}
      <div className="themeCard p-5">
        <div className="mb-4 flex items-center gap-2">
          <Shield size={18} className="text-green-400" />
          <h2 className="text-lg font-semibold">{t('admin.systemHealth')}</h2>
        </div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="rounded-lg border border-[var(--border)] p-4 text-center">
            <div className="text-xs uppercase tracking-wider mb-2" style={{ color: "var(--muted)" }}>{t('admin.apiServer')}</div>
            <div className="font-semibold italic text-green-400">{t('status.online')}</div>
          </div>
          <div className="rounded-lg border border-[var(--border)] p-4 text-center">
            <div className="text-xs uppercase tracking-wider mb-2" style={{ color: "var(--muted)" }}>{t('admin.workerProcess')}</div>
            <div className="font-semibold italic text-green-400">{t('status.running')} ({runningWorkers})</div>
          </div>
          <div className="rounded-lg border border-[var(--border)] p-4 text-center">
            <div className="text-xs uppercase tracking-wider mb-2" style={{ color: "var(--muted)" }}>{t('admin.queue')}</div>
            <div className="font-semibold italic text-blue-400">{t('status.empty')} (0)</div>
          </div>
          <div className="rounded-lg border border-[var(--border)] p-4 text-center">
            <div className="text-xs uppercase tracking-wider mb-2" style={{ color: "var(--muted)" }}>{t('admin.proxyHealth')}</div>
            <div className="font-semibold italic text-green-400">98%</div>
          </div>
        </div>
      </div>
    </div>
  );
}
