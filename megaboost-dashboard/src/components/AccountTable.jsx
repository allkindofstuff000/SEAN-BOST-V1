import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LoaderCircle, Play, Square } from "lucide-react";
import { useAccounts } from "../context/AccountsContext";
import AccountDetailsModal from "./AccountDetailsModal";
import DeleteConfirmModal from "./DeleteConfirmModal";
import AccountRow from "./AccountRow";
import VerificationModal from "./VerificationModal";
import { isRunningLikeStatus } from "../utils/accountStatus";

export default function AccountTable() {
  const navigate = useNavigate();
  const {
    accounts,
    loading,
    error,
    toggleStatus,
    deleteAccount,
    restartAccount,
    startAllAccounts,
    stopAllAccounts,
    isGlobalPending,
    isAccountPending,
    queueState,
    showToast,
    fetchAccounts
  } = useAccounts();

  const [selectedAccount, setSelectedAccount] = useState(null);
  const [detailsAccount, setDetailsAccount] = useState(null);
  const [verificationAccount, setVerificationAccount] = useState(null);

  const runningCount = useMemo(
    () => accounts.filter((account) => isRunningLikeStatus(account.status)).length,
    [accounts]
  );

  const stoppedCount = useMemo(
    () => accounts.filter((account) => account.status === "stopped").length,
    [accounts]
  );

  const crashedCount = useMemo(
    () => accounts.filter((account) => account.status === "crashed").length,
    [accounts]
  );

  const handleToggle = useCallback(
    async (account) => {
      await toggleStatus(account._id, account.status);
    },
    [toggleStatus]
  );

  const handleStartAll = useCallback(async () => {
    try {
      await startAllAccounts(accounts);
    } catch {
      // Toast is handled by context.
    }
  }, [accounts, startAllAccounts]);

  const handleStopAll = useCallback(async () => {
    try {
      await stopAllAccounts(accounts);
    } catch {
      // Toast is handled by context.
    }
  }, [accounts, stopAllAccounts]);

  const handleRestart = useCallback(
    async (id) => {
      try {
        const result = await restartAccount(id);
        if (result) {
          showToast("Restart requested", "success");
        }
      } catch (apiError) {
        showToast(`Restart failed: ${apiError.response?.data?.message || apiError.message}`, "error");
      }
    },
    [restartAccount, showToast]
  );

  const pendingCount = queueState?.totalPending || 0;

  const handleView = useCallback(
    (account) => {
      setDetailsAccount(account);
    },
    []
  );

  const handleEdit = useCallback(
    (account) => {
      const routeAccountId = account?.id ?? account?._id;
      if (!routeAccountId) return;
      navigate(`/dashboard/accounts/${routeAccountId}/edit`);
    },
    [navigate]
  );

  return (
    <div className="bg-card themeBorder rounded-xl border overflow-hidden mt-6">
      <div className="accountTableBulk themePanelHeader themeBorder flex flex-col gap-3 p-4 border-b sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold">Bulk Operations</h2>
          <div className="text-xs text-yellow-300 mt-1">Queue {pendingCount} pending</div>
        </div>

        <div className="accountTableActions flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <button
            type="button"
            onClick={handleStartAll}
            disabled={isGlobalPending}
            className="themeBtnAccent flex w-full sm:w-auto items-center justify-center gap-2 px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGlobalPending ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
            Start All
          </button>
          <button
            type="button"
            onClick={handleStopAll}
            disabled={isGlobalPending}
            className="themeBtnMuted flex w-full sm:w-auto items-center justify-center gap-2 px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGlobalPending ? <LoaderCircle size={14} className="animate-spin" /> : <Square size={14} />}
            Stop All
          </button>
          <div className="accountTableStats text-xs opacity-80">
            <span className="text-green-400 mr-3">Running {runningCount}</span>
            <span className="text-gray-400 mr-3">Stopped {stoppedCount}</span>
            <span className="text-red-400">Crashed {crashedCount}</span>
          </div>
        </div>
      </div>

      <div className="accountTableHeader themePanelHeader themeBorder hidden sm:grid grid-cols-9 p-4 text-sm font-semibold border-t border-b">
        <div>Account</div>
        <div>Status</div>
        <div>Proxy</div>
        <div>Connection Test</div>
        <div>Next Bump</div>
        <div>Countdown</div>
        <div>Progress</div>
        <div>Created</div>
        <div>Actions</div>
      </div>

      {loading && <div className="p-6 text-center text-sm opacity-70">Loading accounts...</div>}
      {error && <div className="p-6 text-center text-sm text-red-400">{error}</div>}

      {!loading && !error && accounts.length === 0 && (
        <div className="p-6 text-center text-sm opacity-60">No accounts available.</div>
      )}

      {accounts.map((account) => (
        <AccountRow
          key={account._id}
          account={account}
          pending={isAccountPending(account._id)}
          onToggle={handleToggle}
          onRestart={handleRestart}
          onDelete={setSelectedAccount}
          onView={handleView}
          onEdit={handleEdit}
          onOpen2fa={setVerificationAccount}
        />
      ))}

      {selectedAccount && (
        <DeleteConfirmModal
          account={selectedAccount}
          pending={isAccountPending(selectedAccount._id)}
          onConfirm={async (id) => {
            await deleteAccount(id);
            setSelectedAccount(null);
          }}
          onCancel={() => setSelectedAccount(null)}
        />
      )}

      {detailsAccount && (
        <AccountDetailsModal
          account={detailsAccount}
          onClose={() => setDetailsAccount(null)}
        />
      )}

      {verificationAccount && (
        <VerificationModal
          account={verificationAccount}
          onClose={() => setVerificationAccount(null)}
          onSuccess={async () => {
            setVerificationAccount(null);
            await fetchAccounts();
          }}
        />
      )}
    </div>
  );
}
