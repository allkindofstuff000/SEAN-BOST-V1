/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { io } from "socket.io-client";
import api, { getLicenseLimits, getSocketBaseUrl } from "../lib/api";
import useOptimisticAccounts from "../hooks/useOptimisticAccounts";
import {
  buildAccountSelectors,
  getAccountTotalBumps
} from "../utils/accountStatus";

const AccountsContext = createContext();
const LICENSE_CACHE_TTL_MS = 60_000;

function ToastStack({ toasts }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[10000] flex w-[320px] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`rounded-md border px-3 py-2 text-sm shadow-lg ${
            toast.type === "error"
              ? "border-red-700 bg-red-950 text-red-100"
              : "border-green-700 bg-green-950 text-green-100"
          }`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}

function normalizeLicense(payload) {
  const raw = payload?.data ? payload.data : payload;
  const status = String(
    raw?.status || (raw?.active === false ? "inactive" : "active")
  )
    .trim()
    .toLowerCase();
  const usedRaw = Number(raw?.usedAccounts ?? raw?.used ?? 0);
  const limitRaw = Number(raw?.maxAccounts ?? raw?.limit ?? raw?.accountLimit ?? 0);

  return {
    used: Number.isFinite(usedRaw) ? Math.max(0, Math.floor(usedRaw)) : 0,
    limit: Number.isFinite(limitRaw) ? Math.max(0, Math.floor(limitRaw)) : 0,
    active: status === "active",
    status,
    expiresAt: raw?.expiresAt || raw?.expires_at || null,
    key: raw?.key || null
  };
}

function buildLimitMessage(license) {
  if (!license?.limit || license.limit > 1_000_000_000) {
    return "License limit reached";
  }

  return `License limit reached (${license.used}/${license.limit})`;
}

export function AccountsProvider({ children }) {
  const [accounts, setAccounts] = useState([]);
  const [accountLimit, setAccountLimit] = useState(15);
  const [usedAccounts, setUsedAccounts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toasts, setToasts] = useState([]);
  const [licenseInfo, setLicenseInfo] = useState(null);

  const licenseCacheRef = useRef({ data: null, fetchedAt: 0 });

  const showToast = useCallback((message, type = "error") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    setToasts((prev) => [...prev, { id, message, type }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 2800);
  }, []);

  const notifyError = useCallback(
    (message) => {
      showToast(message, "error");
    },
    [showToast]
  );

  const notifySuccess = useCallback(
    (message) => {
      showToast(message, "success");
    },
    [showToast]
  );

  const fetchLicenseInfo = useCallback(async ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && licenseCacheRef.current.data && now - licenseCacheRef.current.fetchedAt < LICENSE_CACHE_TTL_MS) {
      return licenseCacheRef.current.data;
    }

    const payload = await getLicenseLimits();
    const normalized = normalizeLicense(payload);

    licenseCacheRef.current = {
      data: normalized,
      fetchedAt: now
    };

    setLicenseInfo(normalized);
    return normalized;
  }, []);

  const ensureLicenseAllows = useCallback(
    async ({ action, additionalAccounts = 0 } = {}) => {
      const license = await fetchLicenseInfo();

      if (!license.active) {
        const message = `License is ${license.status || "inactive"}. Operation blocked.`;
        notifyError(message);
        const err = new Error(message);
        err.status = 403;
        throw err;
      }

      const needsCountGuard = action === "add" || action === "start_all";
      if (needsCountGuard && license.limit > 0 && license.used + additionalAccounts > license.limit) {
        const message = buildLimitMessage(license);
        notifyError(message);
        const err = new Error(message);
        err.status = 403;
        throw err;
      }

      return license;
    },
    [fetchLicenseInfo, notifyError]
  );

  const {
    pendingMutations,
    queueState,
    isAccountPending,
    isGlobalPending,
    cancelQueuedMutation,
    startAccount,
    stopAccount,
    restartAccount,
    deleteAccount,
    startAllAccounts,
    stopAllAccounts,
    addAccount,
    updateAccountSettings,
    toggleStatus,
    mergeServerAccounts,
    applySocketAccountUpdate
  } = useOptimisticAccounts({
    accounts,
    setAccounts,
    setUsedAccounts,
    setAccountLimit,
    notifyError,
    notifySuccess,
    ensureLicenseAllows,
    maxConcurrency: Number(import.meta.env.VITE_MUTATION_MAX_CONCURRENCY || 5)
  });

  const fetchAccounts = useCallback(async () => {
    try {
      setError("");
      const response = await api.get("/api/accounts");
      const payload = response.data || {};
      const incomingAccounts = payload.data || [];

      mergeServerAccounts(incomingAccounts);
      setAccountLimit(payload.meta?.accountLimit || 15);
      setUsedAccounts(
        payload.meta?.usedAccounts || (Array.isArray(incomingAccounts) ? incomingAccounts.length : 0)
      );
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, [mergeServerAccounts]);

  useEffect(() => {
    fetchAccounts();
    fetchLicenseInfo().catch((licenseError) => {
      console.error("Failed to load license info", licenseError);
    });
  }, [fetchAccounts, fetchLicenseInfo]);

  useEffect(() => {
    const pollMs = Number(import.meta.env.VITE_ACCOUNTS_POLL_MS || 4000);
    const intervalId = setInterval(() => {
      fetchAccounts();
    }, Number.isNaN(pollMs) ? 4000 : pollMs);

    return () => clearInterval(intervalId);
  }, [fetchAccounts]);

  useEffect(() => {
    const socket = io(getSocketBaseUrl(), {
      withCredentials: true,
      transports: ["websocket", "polling"]
    });

    socket.on("account:update", (payload) => {
      applySocketAccountUpdate(payload);
    });

    return () => {
      socket.disconnect();
    };
  }, [applySocketAccountUpdate]);

  const retestConnection = useCallback(
    async (id) => {
      const response = await api.post(`/api/accounts/${id}/test-connection`);
      await fetchAccounts();
      return response.data;
    },
    [fetchAccounts]
  );

  const getVerification = useCallback(async (id) => {
    const response = await api.get(`/api/accounts/${id}/verification`);
    return response.data?.data || response.data;
  }, []);

  const submitVerification = useCallback(
    async (id, code, options = {}) => {
      let response;
      try {
        response = await api.post(
          `/api/accounts/${id}/verification`,
          { code },
          { timeoutMs: 45000, ...options }
        );
      } catch (error) {
        if (error?.status !== 404) {
          throw error;
        }
        response = await api.post(
          `/api/accounts/${id}/2fa`,
          { code },
          { timeoutMs: 45000, ...options }
        );
      }
      await fetchAccounts();
      return response.data;
    },
    [fetchAccounts]
  );

  const selectors = useMemo(() => buildAccountSelectors(accounts), [accounts]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    console.table(
      accounts.map((account) => ({
        email: account?.email || "",
        status: account?.status || "",
        totalBumps: getAccountTotalBumps(account)
      }))
    );
  }, [accounts]);

  const value = useMemo(
    () => ({
      accounts,
      accountLimit,
      usedAccounts,
      loading,
      error,
      selectors,
      licenseInfo,
      pendingMutations,
      queueState,
      isGlobalPending,
      isAccountPending,
      cancelQueuedMutation,
      fetchAccounts,
      fetchLicenseInfo,
      ensureLicenseAllows,
      addAccount,
      deleteAccount,
      updateAccountSettings,
      toggleStatus,
      startAccount,
      stopAccount,
      restartAccount,
      startAllAccounts,
      stopAllAccounts,
      retestConnection,
      getVerification,
      submitVerification,
      showToast
    }),
    [
      accounts,
      accountLimit,
      usedAccounts,
      loading,
      error,
      selectors,
      licenseInfo,
      pendingMutations,
      queueState,
      isGlobalPending,
      isAccountPending,
      cancelQueuedMutation,
      fetchAccounts,
      fetchLicenseInfo,
      ensureLicenseAllows,
      addAccount,
      deleteAccount,
      updateAccountSettings,
      toggleStatus,
      startAccount,
      stopAccount,
      restartAccount,
      startAllAccounts,
      stopAllAccounts,
      retestConnection,
      getVerification,
      submitVerification,
      showToast
    ]
  );

  return (
    <AccountsContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} />
    </AccountsContext.Provider>
  );
}

export function useAccounts() {
  return useContext(AccountsContext);
}
