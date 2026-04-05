import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../lib/api";
import { useLanguage } from "../context/LanguageContext";
import { formatDateTimeBDT } from "../utils/timeDisplay";

const PAGE_LIMIT = 50;
const EMPTY_STATS = {
  total: 0,
  success: 0,
  warning: 0,
  error: 0,
  info: 0
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStats(value) {
  if (!isPlainObject(value)) {
    return { ...EMPTY_STATS };
  }

  return {
    total: Number(value.total) || 0,
    success: Number(value.success) || 0,
    warning: Number(value.warning) || 0,
    error: Number(value.error) || 0,
    info: Number(value.info) || 0
  };
}

function formatDateTime(value) {
  return formatDateTimeBDT(value);
}

const LEVEL_STYLES = {
  success: {
    background: "rgba(14,203,129,0.15)",
    color: "#0ecb81",
    borderColor: "rgba(14,203,129,0.35)"
  },
  warning: {
    background: "rgba(245,158,11,0.15)",
    color: "#f59e0b",
    borderColor: "rgba(245,158,11,0.35)"
  },
  error: {
    background: "rgba(246,70,93,0.15)",
    color: "#f6465d",
    borderColor: "rgba(246,70,93,0.35)"
  },
  info: {
    background: "rgba(59,130,246,0.15)",
    color: "#3b82f6",
    borderColor: "rgba(59,130,246,0.35)"
  }
};

function levelBadgeStyle(level) {
  return LEVEL_STYLES[level] || LEVEL_STYLES.info;
}

function getVisiblePages(currentPage, totalPages) {
  const safeTotal = Math.max(1, totalPages);

  if (safeTotal <= 7) {
    return Array.from({ length: safeTotal }, (_, index) => index + 1);
  }

  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, "...", safeTotal];
  }

  if (currentPage >= safeTotal - 3) {
    return [1, "...", safeTotal - 4, safeTotal - 3, safeTotal - 2, safeTotal - 1, safeTotal];
  }

  return [1, "...", currentPage - 1, currentPage, currentPage + 1, "...", safeTotal];
}

function resolveDisplayKey(log) {
  const email = String(log?.email || "").trim();
  if (email) {
    return email;
  }

  const accountId = String(log?.accountId || "").trim();
  if (accountId) {
    return accountId;
  }

  if (isPlainObject(log?.metadata)) {
    const accountKey = String(log.metadata.accountKey || "").trim();
    if (accountKey) {
      return accountKey;
    }
  }

  return "";
}

export default function ActivityLogs() {
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [limit, setLimit] = useState(PAGE_LIMIT);
  const [page, setPage] = useState(1);

  const [level, setLevel] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [appliedFilters, setAppliedFilters] = useState({ level: "all", q: "" });

  // Analytics data from dedicated endpoints
  const [sourceIps, setSourceIps] = useState({ data: [], uniqueCount: 0, flaggedCount: 0 });
  const [affectedAccounts, setAffectedAccounts] = useState({ data: [], accountsTouched: 0, deletedCount: 0 });

  const [stats, setStats] = useState(EMPTY_STATS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoPaused, setAutoPaused] = useState(false);

  const isFetchingRef = useRef(false);
  const pendingFetchRef = useRef(null);
  const intervalRef = useRef(null);
  const scrollPauseTimerRef = useRef(null);
  const typingPauseTimerRef = useRef(null);

  const autoRefreshRef = useRef(false);
  const pausedRef = useRef(false);
  const pageRef = useRef(1);
  const filtersRef = useRef({ level: "all", q: "" });
  const lastScrollTimeRef = useRef(0);

  const scrollPausedRef = useRef(false);
  const typingPausedRef = useRef(false);

  const syncPausedState = useCallback(() => {
    const nextPaused = scrollPausedRef.current || typingPausedRef.current;
    pausedRef.current = nextPaused;
    setAutoPaused(nextPaused);
  }, []);

  const pauseForScroll = useCallback(() => {
    if (!autoRefreshRef.current) {
      return;
    }

    lastScrollTimeRef.current = Date.now();
    scrollPausedRef.current = true;
    syncPausedState();

    if (scrollPauseTimerRef.current) {
      clearTimeout(scrollPauseTimerRef.current);
    }

    scrollPauseTimerRef.current = setTimeout(() => {
      const idleFor = Date.now() - lastScrollTimeRef.current;
      if (idleFor >= 2000) {
        scrollPausedRef.current = false;
        syncPausedState();
      }
    }, 2000);
  }, [syncPausedState]);

  const pauseForTyping = useCallback(() => {
    if (!autoRefreshRef.current) {
      return;
    }

    typingPausedRef.current = true;
    syncPausedState();

    if (typingPauseTimerRef.current) {
      clearTimeout(typingPauseTimerRef.current);
    }

    typingPauseTimerRef.current = setTimeout(() => {
      typingPausedRef.current = false;
      syncPausedState();
    }, 800);
  }, [syncPausedState]);

  const fetchLogs = useCallback(async ({ targetPage = pageRef.current, filters = filtersRef.current, silent = false } = {}) => {
    if (isFetchingRef.current) {
      pendingFetchRef.current = { targetPage, filters, silent };
      return;
    }

    isFetchingRef.current = true;

    if (!silent) {
      setLoading(true);
    }

    setError("");

    try {
      const safeLevel = filters.level || "all";
      const safeQuery = filters.q || "";
      const response = await api.get(
        `/api/logs?page=${targetPage}&limit=${PAGE_LIMIT}&level=${encodeURIComponent(
          safeLevel
        )}&q=${encodeURIComponent(safeQuery)}`,
        { cache: "no-store" }
      );

      const rawPayload = response?.data;
      const payload =
        isPlainObject(rawPayload?.data) &&
        Array.isArray(rawPayload?.data?.items)
          ? rawPayload.data
          : rawPayload;

      if (!isPlainObject(payload)) {
        console.error("[ActivityLogs] Unexpected payload type:", rawPayload);
        throw new Error("Unexpected response from logs API.");
      }

      if (!Array.isArray(payload.items)) {
        console.error("[ActivityLogs] Expected payload.items array. Payload:", payload);
        throw new Error("Logs response is missing items list.");
      }

      const parsedTotal = Number(payload.total);
      const totalValue = Number.isFinite(parsedTotal) ? parsedTotal : payload.items.length;
      const parsedPages = Number(payload.pages);
      const pagesValue = Number.isFinite(parsedPages)
        ? parsedPages
        : Math.ceil(totalValue / PAGE_LIMIT);
      const parsedLimit = Number(payload.limit);
      const limitValue =
        Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : PAGE_LIMIT;

      setItems(payload.items);
      setTotal(totalValue);
      setPages(pagesValue);
      setLimit(limitValue);
      setStats(normalizeStats(payload.stats));
    } catch (fetchError) {
      console.error("[ActivityLogs] Error fetching logs:", fetchError);
      setError(
        fetchError?.message ||
          "Unable to load activity logs right now. Please retry."
      );
    } finally {
      isFetchingRef.current = false;

      if (!silent) {
        setLoading(false);
      }

      if (pendingFetchRef.current) {
        const nextFetch = pendingFetchRef.current;
        pendingFetchRef.current = null;
        fetchLogs(nextFetch);
      }
    }
  }, []);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    filtersRef.current = appliedFilters;
  }, [appliedFilters]);

  useEffect(() => {
    autoRefreshRef.current = autoRefresh;

    if (!autoRefresh) {
      scrollPausedRef.current = false;
      typingPausedRef.current = false;
      syncPausedState();

      if (scrollPauseTimerRef.current) {
        clearTimeout(scrollPauseTimerRef.current);
        scrollPauseTimerRef.current = null;
      }

      if (typingPauseTimerRef.current) {
        clearTimeout(typingPauseTimerRef.current);
        typingPauseTimerRef.current = null;
      }
    }
  }, [autoRefresh, syncPausedState]);

  useEffect(() => {
    fetchLogs({ targetPage: page, filters: appliedFilters });
  }, [page, appliedFilters, fetchLogs]);

  // Fetch analytics from dedicated endpoints
  useEffect(() => {
    const loadAnalytics = async () => {
      try {
        const [ipsRes, accountsRes] = await Promise.all([
          api.get("/api/logs/source-ips"),
          api.get("/api/logs/affected-accounts")
        ]);
        if (ipsRes?.data) setSourceIps(ipsRes.data);
        if (accountsRes?.data) setAffectedAccounts(accountsRes.data);
      } catch {
        // silent — analytics are non-critical
      }
    };
    loadAnalytics();
  }, [appliedFilters]);

  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      if (pausedRef.current || isFetchingRef.current) {
        return;
      }

      fetchLogs({
        targetPage: pageRef.current,
        filters: filtersRef.current,
        silent: true
      });
    }, 5000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, fetchLogs]);

  useEffect(() => {
    const handleScrollActivity = () => {
      pauseForScroll();
    };

    window.addEventListener("scroll", handleScrollActivity, { passive: true });
    window.addEventListener("wheel", handleScrollActivity, { passive: true });
    window.addEventListener("touchmove", handleScrollActivity, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScrollActivity);
      window.removeEventListener("wheel", handleScrollActivity);
      window.removeEventListener("touchmove", handleScrollActivity);
    };
  }, [pauseForScroll]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }

      if (scrollPauseTimerRef.current) {
        clearTimeout(scrollPauseTimerRef.current);
      }

      if (typingPauseTimerRef.current) {
        clearTimeout(typingPauseTimerRef.current);
      }
    };
  }, []);

  const totalPages = Math.max(1, pages);
  const visiblePages = useMemo(() => getVisiblePages(page, totalPages), [page, totalPages]);

  const showingFrom = total === 0 ? 0 : (page - 1) * limit + 1;
  const showingTo = total === 0 ? 0 : Math.min(page * limit, total);

  const statCards = [
    { label: t('logs.total'), value: stats.total, color: "#e2e8f0" },
    { label: t('logs.success'), value: stats.success, color: "#0ecb81" },
    { label: t('logs.warning'), value: stats.warning, color: "#f59e0b" },
    { label: t('logs.error'), value: stats.error, color: "#f6465d" },
    { label: t('logs.info'), value: stats.info, color: "#3b82f6" }
  ];

  const applyFilters = () => {
    const nextFilters = {
      level,
      q: searchInput.trim()
    };

    const sameFilters =
      nextFilters.level === appliedFilters.level &&
      nextFilters.q === appliedFilters.q;

    if (sameFilters && page === 1) {
      fetchLogs({ targetPage: 1, filters: nextFilters });
      return;
    }

    setPage(1);
    setAppliedFilters(nextFilters);
  };

  const clearFilters = () => {
    const cleared = { level: "all", q: "" };

    setSearchInput("");
    setLevel("all");

    const sameFilters = appliedFilters.level === "all" && appliedFilters.q === "";

    if (sameFilters && page === 1) {
      fetchLogs({ targetPage: 1, filters: cleared });
      return;
    }

    setPage(1);
    setAppliedFilters(cleared);
  };

  const goToPage = (nextPage) => {
    if (nextPage < 1 || nextPage > totalPages || nextPage === page) {
      return;
    }

    setPage(nextPage);
  };

  return (
    <div className="space-y-5" style={{ maxWidth: "1400px", margin: "0 auto", width: "100%" }}>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold">{t('logs.title')}</h1>
          <p className="text-sm opacity-70">{t('logs.subtitle')}</p>
        </div>

        <button
          type="button"
          onClick={() => navigate("/")}
          className="w-full sm:w-auto rounded-lg border themeBorder px-4 py-2 text-sm font-medium transition hover:bg-[#161b22]"
        >
          {t('logs.backToDashboard')}
        </button>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {statCards.map((card) => (
          <article key={card.label} className="themeCard flex items-center justify-between p-4">
            <p className="text-sm font-semibold uppercase tracking-wider opacity-70">{card.label}</p>
            <p className="text-2xl font-bold" style={{ color: card.color }}>
              {card.value}
            </p>
          </article>
        ))}
      </section>

      <div className="themeTabBar">
        {[
          { key: "all", label: t('logs.allLevels') },
          { key: "success", label: t('logs.success') },
          { key: "warning", label: t('logs.warning') },
          { key: "error", label: t('logs.error') },
          { key: "info", label: t('logs.info') }
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`themeTab ${level === tab.key ? "is-active" : ""}`}
            onClick={() => {
              setLevel(tab.key);
              setPage(1);
              setAppliedFilters((prev) => ({ ...prev, level: tab.key }));
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section className="themeCard overflow-hidden">
        {error && (
          <div className="m-4 rounded-md border border-red-700/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {loading && items.length === 0 && (
          <div className="px-3 py-8 text-center text-sm opacity-70">{t('logs.loadingLogs')}</div>
        )}

        {!loading && items.length === 0 && (
          <div className="px-3 py-8 text-center text-sm opacity-70">{t('logs.noLogsFound')}</div>
        )}

        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="px-4 py-3">{t('logs.time')}</th>
                  <th className="px-4 py-3">{t('logs.level')}</th>
                  <th className="px-4 py-3">{t('logs.message')}</th>
                  <th className="px-4 py-3">{t('logs.email')}</th>
                  <th className="px-4 py-3">{t('logs.ip')}</th>
                  <th className="px-4 py-3">{t('logs.accountId')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((log) => {
                  const displayKey = resolveDisplayKey(log);

                  return (
                    <tr key={log._id} className="border-b border-[var(--border)]">
                      <td className="whitespace-nowrap px-4 py-3 text-sm mono opacity-80">
                        {formatDateTime(log.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="rounded-full border px-2.5 py-1 text-xs font-semibold"
                          style={levelBadgeStyle(log.level)}
                        >
                          {log.level || "info"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">{log.message || "-"}</td>
                      <td className="px-4 py-3 text-sm opacity-80">{displayKey || "—"}</td>
                      <td className="px-4 py-3 text-sm mono opacity-80">{log.ip || "—"}</td>
                      <td className="px-4 py-3 text-sm mono opacity-60">
                        {String(log.accountId || "").slice(0, 9) || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-[var(--border)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm opacity-70">
            {t('logs.page')} {page} {t('logs.of')} {Math.max(1, pages)} &middot; {total} {t('logs.entries')}
          </p>

          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1}
              className="rounded-md border themeBorder px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[#161b22]"
            >
              {t('logs.prev')}
            </button>

            {visiblePages.map((entry, index) => {
              if (entry === "...") {
                return (
                  <span key={`ellipsis-${index}`} className="px-2 text-sm opacity-60">
                    ...
                  </span>
                );
              }

              const pageNumber = Number(entry);
              const active = pageNumber === page;

              return (
                <button
                  key={pageNumber}
                  type="button"
                  onClick={() => goToPage(pageNumber)}
                  className="rounded-md border px-3 py-1.5 text-sm"
                  style={
                    active
                      ? { borderColor: "var(--accent)", background: "rgba(245,166,35,0.18)", color: "var(--accent)" }
                      : { borderColor: "var(--border)" }
                  }
                >
                  {pageNumber}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages}
              className="rounded-md border themeBorder px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[#161b22]"
            >
              {t('logs.next')}
            </button>
          </div>
        </div>
      </section>

      {/* Analytics three-column section */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Level Breakdown */}
        <div className="themeCard p-5">
          <div className="mb-4 flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--info)" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
            <h3 className="font-semibold">{t('logs.levelBreakdown')}</h3>
          </div>

          <div className="space-y-3">
            {[
              { label: "Info", count: stats.info, color: "#3b82f6" },
              { label: "Warning", count: stats.warning, color: "#eab308" },
              { label: "Error", count: stats.error, color: "#ef4444" },
              { label: "Success", count: stats.success, color: "#22c55e" }
            ].map((row) => (
              <div key={row.label}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm">{row.label}</span>
                  <span className="text-sm font-semibold" style={{ color: row.color }}>{row.count}</span>
                </div>
                <div className="h-2 rounded-full" style={{ background: "var(--border)" }}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${stats.total ? Math.max(2, (row.count / stats.total) * 100) : 0}%`,
                      background: row.color
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 text-xs mono" style={{ color: "var(--muted)" }}>
            Last log: {items.length > 0 ? formatDateTime(items[0]?.createdAt) : "—"}
          </div>
        </div>

        {/* Source IPs */}
        <div className="themeCard p-5">
          <div className="mb-4 flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <h3 className="font-semibold">{t('logs.sourceIps')}</h3>
          </div>

          <div className="space-y-2">
            {sourceIps.data.length === 0 ? (
              <div className="text-sm py-2" style={{ color: "var(--muted)" }}>{t('logs.noIpData')}</div>
            ) : (
              sourceIps.data.slice(0, 5).map((entry) => (
                <div key={entry.ip} className="flex items-center justify-between rounded-lg border border-[var(--border)] p-3">
                  <div>
                    <div className="font-semibold text-sm mono">{entry.ip}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>{entry.lastAction || t('logs.userAction')}</div>
                  </div>
                  <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: "rgba(59,130,246,0.15)", color: "#3b82f6" }}>
                    {entry.eventCount} {t('logs.events')}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
            {sourceIps.uniqueCount} {t('logs.uniqueIp')} &middot; {sourceIps.flaggedCount} {t('logs.flagged')}
          </div>
        </div>

        {/* Affected Accounts */}
        <div className="themeCard p-5">
          <div className="mb-4 flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <h3 className="font-semibold">{t('logs.affectedAccounts')}</h3>
          </div>

          <div className="space-y-2">
            {affectedAccounts.data.length === 0 ? (
              <div className="text-sm py-2" style={{ color: "var(--muted)" }}>{t('logs.noAccountData')}</div>
            ) : (
              affectedAccounts.data.slice(0, 5).map((entry) => (
                <div key={entry.email} className="flex items-center justify-between rounded-lg border border-[var(--border)] p-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm truncate">{entry.email}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>{entry.count} {t('logs.logEntries')}</div>
                  </div>
                  {entry.deleted && (
                    <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}>
                      {t('status.deleted')}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="mt-3 space-y-1 text-xs" style={{ color: "var(--muted)" }}>
            <div>{t('logs.accountsTouched')} <strong className="text-white">{affectedAccounts.accountsTouched}</strong></div>
            {affectedAccounts.deletedCount > 0 && (
              <div>{t('logs.deletedAccounts')} <strong className="text-red-400">{affectedAccounts.deletedCount}</strong></div>
            )}
          </div>
        </div>
      </div>

      {/* Log Export & Tools */}
      <div className="themeCard p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-semibold text-lg">{t('logs.exportTitle')}</h3>
            <p className="text-sm" style={{ color: "var(--muted)" }}>{t('logs.exportSubtitle')}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="themeBtnTeal inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
              onClick={() => window.open("/api/logs/export?format=csv", "_blank")}
            >
              {t('logs.exportCsv')}
            </button>
            <button
              type="button"
              className="themeBtnMuted inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
              style={{ borderColor: "rgba(59,130,246,0.5)", color: "#3b82f6" }}
              onClick={() => window.open("/api/logs/export?format=json", "_blank")}
            >
              {t('logs.exportJson')}
            </button>
            <button
              type="button"
              className="themeBtnDanger inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
              onClick={() => {
                if (window.confirm(t('logs.clearConfirm'))) {
                  api.delete("/api/logs/clear").then(() => {
                    setItems([]);
                    setTotal(0);
                    setStats(EMPTY_STATS);
                  }).catch(() => {});
                }
              }}
            >
              {t('logs.clearLogs')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
