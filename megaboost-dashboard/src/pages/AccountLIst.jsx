import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Ban,
  PauseCircle,
  Play,
  Plus,
  Shield,
  Square,
  Target,
  Users
} from "lucide-react";

import { useAccounts } from "../context/AccountsContext";
import AccountTable from "../components/AccountTable";
import OptimisticTestPanel from "../components/OptimisticTestPanel";

export default function AccountList() {
  const navigate = useNavigate();
  const { loading, error, selectors } = useAccounts();

  return (
    <div className="pageInner">
      <div className="flex flex-col gap-4 mb-6 sm:flex-row sm:justify-between sm:items-center">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
            <Users size={28} />
            Account Management
          </h1>
          <p className="opacity-70 mt-1">Manage your accounts and monitor their status</p>
        </div>

        <button
          onClick={() => navigate("/accounts/add")}
          className="themeBtnAccent flex w-full sm:w-auto items-center justify-center gap-2 px-4 py-2"
        >
          <Plus size={18} />
          Add Account
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:gap-6 mb-8 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total" value={selectors.total} icon={<Users size={18} />} />
        <StatCard title="Running" value={selectors.running} icon={<Play size={18} />} />
        <StatCard title="Needs 2FA" value={selectors.needs2fa} icon={<Shield size={18} />} />
        <StatCard title="Stopped" value={selectors.stopped} icon={<Square size={18} />} />
        <StatCard title="Paused" value={selectors.paused} icon={<PauseCircle size={18} />} />
        <StatCard title="Crashed" value={selectors.crashed} icon={<AlertTriangle size={18} />} />
        <StatCard title="Banned" value={selectors.banned} icon={<Ban size={18} />} />
        <StatCard title="Total Bumps" value={selectors.totalBumps} icon={<Target size={18} />} />
      </div>

      <OptimisticTestPanel />

      {loading && <p className="text-sm opacity-70 mb-4">Loading accounts...</p>}
      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
      <AccountTable />
    </div>
  );
}

function StatCard({ title, value, icon }) {
  return (
    <div className="bg-card themeBorder p-6 rounded-xl border hover:border-accent transition">
      <div className="flex items-center gap-2 opacity-70 text-sm mb-2">
        {icon}
        {title}
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
