import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Eye,
  LoaderCircle,
  Play,
  RotateCcw,
  Square,
  SquarePen,
  Trash2
} from "lucide-react";
import shield from "../assets/shield.png";
import { isRunningLikeStatus, toStatusClass } from "../utils/accountStatus";
import "./AccountRow.css";

const ONE_SECOND_MS = 1000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toTimestamp(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function formatCountdown(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "-";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function useNowTick(enabled) {
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    const intervalId = window.setInterval(() => {
      setNowTs(Date.now());
    }, ONE_SECOND_MS);
    return () => window.clearInterval(intervalId);
  }, [enabled]);

  return nowTs;
}

function AccountRow({
  account,
  pending,
  onToggle,
  onRestart,
  onDelete,
  onView,
  onEdit,
  onOpen2fa
}) {
  const busy = Boolean(pending);
  const runningLike = isRunningLikeStatus(account.status);
  const show2faShield =
    account.status === "awaiting_2fa" || account.status === "awaiting_verification_code";
  const nextBumpAtMs = useMemo(() => toTimestamp(account.nextBumpAt), [account.nextBumpAt]);
  const hasCountdown = nextBumpAtMs !== null;
  const nowTs = useNowTick(hasCountdown);
  const remainingMs = hasCountdown ? Math.max(nextBumpAtMs - nowTs, 0) : null;
  const isDue = hasCountdown && remainingMs <= 0;
  const baseLastBumpAtMs = useMemo(() => toTimestamp(account.lastBumpAt), [account.lastBumpAt]);
  const fallbackDelayMs = Number(account.nextBumpDelayMs || 0);
  const connectionPending = account.connectionTest?.status === "pending";

  const progress = useMemo(() => {
    if (!hasCountdown || nextBumpAtMs === null) return 0;
    if (isDue) return 1;

    const derivedStartMs =
      baseLastBumpAtMs !== null
        ? baseLastBumpAtMs
        : fallbackDelayMs > 0
          ? nextBumpAtMs - fallbackDelayMs
          : null;

    if (derivedStartMs === null || derivedStartMs >= nextBumpAtMs) {
      return 0;
    }

    const totalMs = nextBumpAtMs - derivedStartMs;
    const elapsedMs = nowTs - derivedStartMs;
    return clamp(elapsedMs / totalMs, 0, 1);
  }, [baseLastBumpAtMs, fallbackDelayMs, hasCountdown, isDue, nextBumpAtMs, nowTs]);

  const progressPercent = Math.round(progress * 100);
  const nextBumpLabel = hasCountdown ? formatTime(account.nextBumpAt) : "-";
  const countdownLabel = hasCountdown ? (isDue ? "Due" : formatCountdown(remainingMs)) : "-";

  const addRipple = useCallback((event) => {
    const button = event.currentTarget;
    button.classList.add("ripple-active");
    window.setTimeout(() => {
      button.classList.remove("ripple-active");
    }, 220);
  }, []);

  const handleToggle = useCallback(() => onToggle(account), [account, onToggle]);
  const handleRestart = useCallback(() => onRestart(account._id), [account._id, onRestart]);
  const handleDelete = useCallback(() => onDelete(account), [account, onDelete]);
  const handleView = useCallback(() => onView?.(account), [account, onView]);
  const handleEdit = useCallback(() => onEdit?.(account), [account, onEdit]);
  const handleOpen2fa = useCallback(() => onOpen2fa?.(account), [account, onOpen2fa]);

  return (
    <div className="accountRow themeBorder text-sm">
      <div className="accountRowCell accountRowAccount" data-label="Account">
        <div className="font-medium break-all">{account.email}</div>
        <div className="text-xs opacity-60 break-all">ID: {account._id}</div>
      </div>

      <div className="accountRowCell" data-label="Status">
        <StatusBadge status={account.status || "stopped"} />
        {account.__syncing && (
          <div className="syncPill">
            <LoaderCircle size={11} className="animate-spin" />
            syncing...
          </div>
        )}
      </div>

      <div className="accountRowCell break-all" data-label="Proxy">
        {account.proxyHost ? `${account.proxyHost}:${account.proxyPort}` : "-"}
      </div>

      <div className="accountRowCell" data-label="Connection Test">
        {account.connectionTest?.testedAt ? (
          <div>
            <div className={account.connectionTest.success ? "text-green-400" : "text-red-400"}>
              {account.connectionTest.success ? "Passed" : "Failed"}
            </div>
            <div className="text-xs opacity-70">
              {new Date(account.connectionTest.testedAt).toLocaleString()}
            </div>
          </div>
        ) : connectionPending ? (
          <span className="text-yellow-300">Pending</span>
        ) : (
          <span className="opacity-60">Not tested</span>
        )}
      </div>

      <div className="accountRowCell" data-label="Next Bump">
        <div className="nextBumpTime">{nextBumpLabel}</div>
      </div>

      <div className="accountRowCell" data-label="Countdown">
        {hasCountdown ? (
          isDue ? (
            <span className="dueBadge">Due</span>
          ) : (
            <span className="countdownValue">{countdownLabel}</span>
          )
        ) : (
          <span className="opacity-60">-</span>
        )}
      </div>

      <div className="accountRowCell" data-label="Progress">
        {hasCountdown ? (
          <div className="nextProgressWrap">
            <div className="nextProgressTrack">
              <div
                className="nextProgressFill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="nextProgressPercent">{progressPercent}%</span>
          </div>
        ) : (
          <span className="opacity-60">-</span>
        )}
      </div>

      <div className="accountRowCell" data-label="Created">
        {new Date(account.createdAt).toLocaleString()}
      </div>

      <div className="accountRowCell accountRowActions" data-label="Actions">
        <div className="actionWrap">
          <button
            onClick={handleToggle}
            onMouseDown={addRipple}
            disabled={busy}
            className={`cyber-btn ripple cyber-tooltip cyber-icon-btn neon-green ${busy ? "disabled" : ""}`}
            data-tip={runningLike ? "Stop" : "Start"}
            type="button"
          >
            {busy ? (
              <LoaderCircle className="actionIcon animate-spin actionStart" />
            ) : runningLike ? (
              <Square className="actionIcon actionStart" />
            ) : (
              <Play className="actionIcon actionStart" />
            )}
          </button>

          <button
            onClick={handleRestart}
            onMouseDown={addRipple}
            disabled={busy}
            className={`cyber-btn ripple cyber-tooltip cyber-icon-btn neon-orange ${busy ? "disabled" : ""}`}
            data-tip="Restart"
            type="button"
          >
            <RotateCcw className="actionIcon actionRestart" />
          </button>

          <button
            onClick={handleView}
            onMouseDown={addRipple}
            disabled={busy}
            className={`cyber-btn ripple cyber-tooltip cyber-icon-btn neon-blue ${busy ? "disabled" : ""}`}
            data-tip="Quick details"
            type="button"
          >
            <Eye className="actionIcon actionView" />
          </button>

          <button
            onClick={handleEdit}
            onMouseDown={addRipple}
            disabled={busy}
            className={`cyber-btn ripple cyber-tooltip cyber-icon-btn neon-yellow ${busy ? "disabled" : ""}`}
            data-tip="Edit"
            type="button"
          >
            <SquarePen className="actionIcon actionEdit" />
          </button>

          {show2faShield && (
            <button
              onClick={handleOpen2fa}
              onMouseDown={addRipple}
              disabled={busy}
              className={`cyber-btn ripple cyber-tooltip cyber-icon-btn neon-blue shieldBtn pulse-blue ${busy ? "disabled" : ""}`}
              data-tip="Awaiting 2FA Code"
              type="button"
            >
              <img src={shield} alt="2FA" />
            </button>
          )}

          <button
            onClick={handleDelete}
            onMouseDown={addRipple}
            disabled={busy}
            className={`cyber-btn ripple cyber-tooltip cyber-icon-btn neon-red ${busy ? "disabled" : ""}`}
            data-tip="Delete"
            type="button"
          >
            <Trash2 className="actionIcon actionDelete" />
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const labels = {
    awaiting_verification_code: "awaiting verification code",
    awaiting_2fa: "awaiting 2fa",
    needs2fa: "awaiting verification code",
    active: "running",
    bumping: "running",
    starting: "starting",
    restarting: "restarting",
    waiting_cooldown: "cooldown"
  };

  const normalized = String(status || "default").replace(/\s+/g, "_");
  const cssStatus = toStatusClass(normalized);
  const pulseClass = normalized === "crashed" ? "pulse-red" : "";
  const knownStatuses = new Set([
    "running",
    "restarting",
    "stopped",
    "crashed",
    "error",
    "verification_failed",
    "2fa_failed",
    "awaiting_2fa",
    "awaiting_verification_code",
    "needs2fa"
  ]);
  const resolvedStatus = knownStatuses.has(cssStatus) ? cssStatus : "default";

  return (
    <span className={`statusBadge status-${resolvedStatus} ${pulseClass}`}>
      {labels[status] || status}
    </span>
  );
}

function areEqual(prev, next) {
  return prev.account === next.account && prev.pending === next.pending;
}

export default memo(AccountRow, areEqual);
