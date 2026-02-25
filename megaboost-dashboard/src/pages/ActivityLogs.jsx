import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../lib/api";

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
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "-";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function levelBadgeClass(level) {
  switch (level) {
    case "success":
      return "border-green-500/40 bg-green-500/15 text-green-300";
    case "warning":
      return "border-yellow-500/40 bg-yellow-500/15 text-yellow-300";
    case "error":
      return "border-red-500/40 bg-red-500/15 text-red-300";
    default:
      return "border-blue-500/40 bg-blue-500/15 text-blue-300";
  }
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

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [limit, setLimit] = useState(PAGE_LIMIT);
  const [page, setPage] = useState(1);

  const [level, setLevel] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [appliedFilters, setAppliedFilters] = useState({ level: "all", q: "" });

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
    { label: "Total", value: stats.total, colorClass: "text-white" },
    { label: "Success", value: stats.success, colorClass: "text-green-400" },
    { label: "Warning", value: stats.warning, colorClass: "text-yellow-400" },
    { label: "Error", value: stats.error, colorClass: "text-red-400" },
    { label: "Info", value: stats.info, colorClass: "text-blue-300" }
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
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold">Activity History</h1>
          <p className="text-sm opacity-70">Monitor recent account actions and system events.</p>
        </div>

        <button
          type="button"
          onClick={() => navigate("/")}
          className="w-full sm:w-auto rounded-lg border border-red-700 px-4 py-2 text-sm font-medium transition hover:bg-red-900/40"
        >
          Back to Dashboard
        </button>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {statCards.map((card) => (
          <article key={card.label} className="rounded-xl border border-red-800 bg-card p-4">
            <p className="text-sm opacity-70">{card.label}</p>
            <p className={`mt-2 text-2xl font-bold ${card.colorClass}`}>{card.value}</p>
          </article>
        ))}
      </section>

      <section className="rounded-xl border border-red-800 bg-card p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <input
            type="text"
            placeholder="Search Activities"
            value={searchInput}
            onChange={(event) => {
              setSearchInput(event.target.value);
              pauseForTyping();
            }}
            className="w-full rounded-lg border border-red-900 bg-red-950/30 px-3 py-2 text-sm outline-none placeholder:text-zinc-400 focus:border-red-600"
          />

          <select
            value={level}
            onChange={(event) => {
              setLevel(event.target.value);
              pauseForTyping();
            }}
            className="w-full lg:w-auto min-w-[160px] rounded-lg border border-red-900 bg-red-950/30 px-3 py-2 text-sm outline-none focus:border-red-600"
          >
            <option value="all">All Levels</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
            <option value="info">Info</option>
          </select>

          <button
            type="button"
            onClick={applyFilters}
            className="w-full lg:w-auto rounded-lg bg-accent px-4 py-2 text-sm font-medium"
          >
            Filter
          </button>

          <button
            type="button"
            onClick={clearFilters}
            className="w-full lg:w-auto rounded-lg border border-red-700 px-4 py-2 text-sm font-medium"
          >
            Clear
          </button>

          <label className="ml-0 flex items-center gap-2 text-sm lg:ml-auto">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
              className="h-4 w-4 rounded border-red-700 bg-red-950"
            />
            <span>Auto refresh</span>
          </label>
        </div>

        {autoRefresh && (
          <p className="mt-2 text-xs opacity-70">
            {autoPaused ? "Paused while scrolling" : "Refreshing every 5s"}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-red-800 bg-card p-2 sm:p-4">
        {error && <div className="mb-3 rounded-md border border-red-700 bg-red-950/50 px-3 py-2 text-sm text-red-200">{error}</div>}

        {loading && items.length === 0 && (
          <div className="px-3 py-8 text-center text-sm opacity-70">Loading logs...</div>
        )}

        {!loading && items.length === 0 && (
          <div className="px-3 py-8 text-center text-sm opacity-70">No logs found for this filter.</div>
        )}

        {items.length > 0 && (
          <div className="divide-y divide-red-900/60">
            {items.map((log) => {
              const displayKey = resolveDisplayKey(log);

              return (
                <article key={log._id} className="flex flex-col gap-2 px-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <p className="font-semibold leading-6 break-words">{log.message || "-"}</p>
                    <p className="mt-1 text-xs opacity-70">{formatDateTime(log.createdAt)}</p>

                    {log.ip && (
                      <p className="mt-1 text-xs opacity-70 break-words">{log.ip}</p>
                    )}

                    {displayKey && (
                      <p className="mt-1 text-xs opacity-70 break-words">{displayKey}</p>
                    )}
                  </div>

                  <span className={`self-start rounded-full border px-2.5 py-1 text-xs font-semibold uppercase ${levelBadgeClass(log.level)}`}>
                    {log.level || "info"}
                  </span>
                </article>
              );
            })}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-3 border-t border-red-900/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm opacity-70">
            Showing {showingFrom} to {showingTo} of {total} results
          </p>

          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1}
              className="rounded-md border border-red-700 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
            >
              Prev
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
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    active
                      ? "border-red-500 bg-red-600/25 text-red-100"
                      : "border-red-700 hover:bg-red-900/40"
                  }`}
                >
                  {pageNumber}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages}
              className="rounded-md border border-red-700 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
