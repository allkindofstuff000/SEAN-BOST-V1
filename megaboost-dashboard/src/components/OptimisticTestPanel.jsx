import { useMemo, useState } from "react";
import { useAccounts } from "../context/AccountsContext";

export default function OptimisticTestPanel() {
  const {
    accounts,
    startAccount,
    stopAccount,
    startAllAccounts,
    stopAllAccounts,
    isGlobalPending,
    isAccountPending,
    showToast
  } = useAccounts();

  const [running, setRunning] = useState(false);
  const target = useMemo(() => accounts[0] || null, [accounts]);

  const run = async (handler) => {
    if (running) return;
    setRunning(true);

    try {
      await handler();
    } catch {
      // Mutation layer handles toasts.
    } finally {
      setRunning(false);
    }
  };

  const disabled = running || isGlobalPending;

  return (
    <div className="bg-card themeBorder p-4 rounded-xl border mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">Optimistic Test Panel</h3>
        <span className="text-xs opacity-70">Target: {target ? target.email : "No account"}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <button
          type="button"
          disabled={disabled || !target || isAccountPending(target?._id)}
          onClick={() =>
            run(async () => {
              window.__SIMULATE_FAIL__ = false;
              window.__SIMULATE_DELAY_MS__ = 0;

              if (!target) return;
              if (target.status === "running") {
                await stopAccount(target._id);
              } else {
                await startAccount(target._id);
              }

              showToast("Simulated 200 success", "success");
            })
          }
          className="themeBtnAccent px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Simulate 200 Success
        </button>

        <button
          type="button"
          disabled={disabled || !target || isAccountPending(target?._id)}
          onClick={() =>
            run(async () => {
              window.__SIMULATE_FAIL__ = true;
              window.__SIMULATE_DELAY_MS__ = 0;
              if (!target) return;
              await startAccount(target._id);
              window.__SIMULATE_FAIL__ = false;
            })
          }
          className="themeBtnDanger px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Simulate 500 Error
        </button>

        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            run(async () => {
              window.__SIMULATE_FAIL__ = false;
              window.__SIMULATE_DELAY_MS__ = 1800;

              await startAllAccounts(accounts);
              await stopAllAccounts(accounts);

              window.__SIMULATE_DELAY_MS__ = 0;
            })
          }
          className="themeBtnMuted px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Simulate Delayed Response
        </button>
      </div>
    </div>
  );
}
