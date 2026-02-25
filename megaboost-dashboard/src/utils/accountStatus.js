const RUNNING_STATUSES = new Set([
  "running",
  "bumping",
  "active",
  "ready",
  "starting",
  "restarting",
  "waiting_cooldown"
]);

const NEEDS_2FA_STATUSES = new Set([
  "awaiting_verification_code",
  "awaiting_2fa",
  "needs2fa",
  "needs_2fa",
  "2fa_required",
  "2fa_failed"
]);

const PAUSED_STATUSES = new Set(["paused"]);
const STOPPED_STATUSES = new Set(["stopped"]);
const BANNED_STATUSES = new Set(["banned"]);
const CRASHED_STATUSES = new Set([
  "crashed",
  "error",
  "login_failed",
  "proxy_failed",
  "verification_failed"
]);

const RUNNING_LIKE_STATUSES = new Set([
  ...RUNNING_STATUSES,
  ...NEEDS_2FA_STATUSES,
  "awaiting_captcha"
]);

const START_ALL_ELIGIBLE_STATUSES = new Set([
  "stopped",
  "pending",
  "crashed",
  "completed",
  "paused",
  "error",
  "login_failed",
  "proxy_failed",
  "verification_failed",
  "2fa_failed",
  "blocked"
]);

export function normalizeAccountStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

export function normalizeStatus(rawStatus) {
  const status = normalizeAccountStatus(rawStatus);
  if (RUNNING_STATUSES.has(status)) return "running";
  if (NEEDS_2FA_STATUSES.has(status)) return "needs2fa";
  if (PAUSED_STATUSES.has(status)) return "paused";
  if (STOPPED_STATUSES.has(status)) return "stopped";
  if (CRASHED_STATUSES.has(status)) return "crashed";
  if (BANNED_STATUSES.has(status)) return "banned";
  return "other";
}

export function isRunningLikeStatus(status) {
  return RUNNING_LIKE_STATUSES.has(normalizeAccountStatus(status));
}

export function isStartAllEligibleStatus(status) {
  const normalized = normalizeAccountStatus(status);
  if (!normalized) return true;
  if (isRunningLikeStatus(normalized)) return false;
  if (normalized === "banned") return false;
  return START_ALL_ELIGIBLE_STATUSES.has(normalized);
}

function toSafeBumpNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.floor(numeric));
}

export function getAccountTotalBumps(account) {
  if (!account || typeof account !== "object") return 0;

  const bumpsField = account.bumps;
  const bumpCandidates = [
    account.totalBumps,
    account.bumpCount,
    Array.isArray(bumpsField) ? bumpsField.length : bumpsField,
    account?.metadata?.totalBumps,
    account?.metadata?.bumpCount,
    account.totalBumpsToday
  ];

  for (const candidate of bumpCandidates) {
    const parsed = toSafeBumpNumber(candidate);
    if (parsed !== null) return parsed;
  }

  return 0;
}

export function buildAccountSelectors(accounts = []) {
  const source = Array.isArray(accounts) ? accounts : [];
  const selectors = {
    total: source.length,
    running: 0,
    needs2fa: 0,
    stopped: 0,
    paused: 0,
    crashed: 0,
    banned: 0,
    totalBumps: 0
  };

  source.forEach((account) => {
    const normalized = normalizeStatus(account?.status);
    if (normalized === "running") selectors.running += 1;
    if (normalized === "needs2fa") selectors.needs2fa += 1;
    if (normalized === "stopped") selectors.stopped += 1;
    if (normalized === "paused") selectors.paused += 1;
    if (normalized === "crashed") selectors.crashed += 1;
    if (normalized === "banned") selectors.banned += 1;
    selectors.totalBumps += getAccountTotalBumps(account);
  });

  return selectors;
}

export function toStatusClass(status) {
  const normalized = normalizeStatus(status);
  if (normalized === "running") return "running";
  if (normalized === "needs2fa") return "needs2fa";
  if (normalized === "stopped") return "stopped";
  if (normalized === "paused") return "paused";
  if (normalized === "crashed") return "crashed";
  if (normalized === "banned") return "banned";
  return "default";
}
