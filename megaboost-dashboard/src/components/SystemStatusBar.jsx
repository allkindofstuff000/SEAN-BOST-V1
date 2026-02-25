import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import api, { getSocketBaseUrl } from "../lib/api";
import { useAccounts } from "../context/AccountsContext";
import "./SystemStatusBar.css";

const HEARTBEAT_STALE_MS = 25_000;
const HEARTBEAT_PRUNE_MS = 5_000;

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isNaN(numeric) ? fallback : numeric;
}

export default function SystemStatusBar() {
  const { accounts, queueState, selectors } = useAccounts();
  const [connected, setConnected] = useState(false);
  const [logStats, setLogStats] = useState({ total: 0, error: 0 });
  const [systemSnapshot, setSystemSnapshot] = useState(null);
  const [heartbeatByAccountId, setHeartbeatByAccountId] = useState({});

  useEffect(() => {
    let mounted = true;

    const loadStats = async () => {
      try {
        const response = await api.get("/api/logs/stats");
        const stats = response.data?.data || {};

        if (mounted) {
          setLogStats({
            total: toNumber(stats.total),
            error: toNumber(stats.error)
          });
        }
      } catch (error) {
        console.error("Failed to load status stats", error);
      }
    };

    loadStats();

    const socket = io(getSocketBaseUrl(), {
      withCredentials: true,
      transports: ["websocket", "polling"]
    });

    socket.on("connect", () => {
      setConnected(true);
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    socket.on("stats-update", (payload) => {
      if (!payload) return;
      setLogStats({
        total: toNumber(payload.total),
        error: toNumber(payload.error)
      });
    });

    // Future-proof hook if backend begins emitting consolidated system metrics.
    socket.on("system:status", (payload) => {
      setSystemSnapshot(payload || null);
    });

    socket.on("worker:heartbeat", (payload) => {
      const accountId = String(payload?.accountId || "").trim();
      if (!accountId) return;

      const ts = payload?.timestamp || payload?.ts || new Date().toISOString();
      const nextHeartbeat = {
        ts,
        step: String(payload?.step || ""),
        status: String(payload?.status || ""),
        currentUrl: String(payload?.currentUrl || "")
      };

      console.debug("[worker:heartbeat]", {
        accountId,
        ...nextHeartbeat
      });

      setHeartbeatByAccountId((prev) => ({
        ...prev,
        [accountId]: nextHeartbeat
      }));
    });

    const pruneTimer = window.setInterval(() => {
      const now = Date.now();

      setHeartbeatByAccountId((prev) => {
        const next = {};
        let changed = false;

        Object.entries(prev).forEach(([accountId, beat]) => {
          const ts = new Date(beat?.ts || 0).getTime();
          if (Number.isFinite(ts) && now - ts <= HEARTBEAT_STALE_MS) {
            next[accountId] = beat;
          } else {
            changed = true;
          }
        });

        return changed ? next : prev;
      });
    }, HEARTBEAT_PRUNE_MS);

    return () => {
      mounted = false;
      window.clearInterval(pruneTimer);
      socket.disconnect();
    };
  }, []);

  const computedWorkers = selectors?.running ?? accounts.filter((account) => account.status === "running").length;
  const computedQueue = queueState?.totalPending ?? 0;

  const computedProxyHealth = useMemo(() => {
    const tested = accounts.filter((account) => account.connectionTest?.testedAt);
    if (tested.length === 0) return 98;

    const passed = tested.filter((account) => account.connectionTest?.success).length;
    return Number(((passed / tested.length) * 100).toFixed(1));
  }, [accounts]);

  const computedUptime = useMemo(() => {
    if (!logStats.total) return 99.9;

    const uptime = (1 - logStats.error / logStats.total) * 100;
    return Number(Math.max(0, Math.min(100, uptime)).toFixed(1));
  }, [logStats.error, logStats.total]);

  const heartbeatWorkersRunning = useMemo(() => {
    return Object.keys(heartbeatByAccountId).length;
  }, [heartbeatByAccountId]);

  const workersRunning = toNumber(
    systemSnapshot?.workersRunning,
    Math.max(heartbeatWorkersRunning, computedWorkers)
  );
  const queueValue = toNumber(systemSnapshot?.queue, computedQueue);
  const proxyHealth = toNumber(systemSnapshot?.proxyHealth, computedProxyHealth);
  const uptime = toNumber(systemSnapshot?.uptime, computedUptime);

  return (
    <div className="systemStatusBar" role="status" aria-live="polite">
      <span className="statusSegment statusLive">
        <span className={`statusDot ${connected ? "connected" : "disconnected"}`} />
        {connected ? "Live Connected" : "Live Disconnected"}
        {" - "}
        {`Workers Running: ${workersRunning}`}
      </span>
      <span className="statusDivider">|</span>
      <span className="statusSegment">Heartbeat: {heartbeatWorkersRunning}</span>
      <span className="statusDivider">|</span>
      <span className="statusSegment">Queue: {queueValue}</span>
      <span className="statusDivider">|</span>
      <span className="statusSegment">Proxy Health: {proxyHealth}%</span>
      <span className="statusDivider">|</span>
      <span className="statusSegment">Uptime: {uptime}%</span>
    </div>
  );
}
