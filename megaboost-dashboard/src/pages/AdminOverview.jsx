import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, Users, AlertTriangle, ShieldCheck } from "lucide-react";
import { adminGetOverview } from "../lib/api";
import { useAccounts } from "../context/AccountsContext";

function OverviewCard({ title, value, icon }) {
  return (
    <div className="rounded-xl border border-red-800 bg-card p-4 shadow-[0_0_16px_rgba(255,59,59,0.12)]">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-white/70">{title}</span>
        {icon}
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
    </div>
  );
}

export default function AdminOverview() {
  const navigate = useNavigate();
  const { showToast } = useAccounts();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [overview, setOverview] = useState({
    totalUsers: 0,
    totalLicenses: 0,
    activeLicenses: 0,
    expiringSoon: 0
  });

  useEffect(() => {
    let mounted = true;

    const loadOverview = async () => {
      setLoading(true);
      setError("");
      try {
        const payload = await adminGetOverview();
        if (!mounted) return;
        setOverview({
          totalUsers: Number(payload?.totalUsers || 0),
          totalLicenses: Number(payload?.totalLicenses || 0),
          activeLicenses: Number(payload?.activeLicenses || 0),
          expiringSoon: Number(payload?.expiringSoon || 0)
        });
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

    loadOverview();
    return () => {
      mounted = false;
    };
  }, [showToast]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">Admin Overview</h1>
          <p className="mt-1 text-sm text-white/70">Manage users and license capacity for your SaaS.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewCard title="Total Users" value={loading ? "-" : overview.totalUsers} icon={<Users size={18} className="text-cyan-300" />} />
        <OverviewCard title="Total Licenses" value={loading ? "-" : overview.totalLicenses} icon={<KeyRound size={18} className="text-yellow-300" />} />
        <OverviewCard title="Active Licenses" value={loading ? "-" : overview.activeLicenses} icon={<ShieldCheck size={18} className="text-green-300" />} />
        <OverviewCard title="Expiring in 7 Days" value={loading ? "-" : overview.expiringSoon} icon={<AlertTriangle size={18} className="text-red-300" />} />
      </div>

      {error ? (
        <div className="rounded-lg border border-red-700 bg-red-950/70 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="rounded-xl border border-red-800 bg-card p-5">
        <h2 className="mb-4 text-lg font-semibold">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => navigate("/admin/licenses")}
            className="rounded-lg border border-cyan-500/40 bg-cyan-900/25 px-4 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-800/35"
          >
            Create License
          </button>
          <button
            type="button"
            onClick={() => navigate("/admin/users")}
            className="rounded-lg border border-red-500/40 bg-red-900/25 px-4 py-2 text-sm font-semibold text-red-100 transition hover:bg-red-800/35"
          >
            Create User
          </button>
        </div>
      </div>
    </div>
  );
}
