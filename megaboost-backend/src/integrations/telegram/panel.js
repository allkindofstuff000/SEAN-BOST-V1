function normalizeString(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatPanelTime(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.valueOf())) {
    const fallback = new Date();
    return `${fallback.getFullYear()}-${pad2(fallback.getMonth() + 1)}-${pad2(fallback.getDate())} ${pad2(
      fallback.getHours()
    )}:${pad2(fallback.getMinutes())}:${pad2(fallback.getSeconds())}`;
  }

  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours()
  )}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function normalizeCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function buildPanelText(stats = {}) {
  const userName = escapeHtml(normalizeString(stats.userName) || "Sean");
  const userHandle = escapeHtml((normalizeString(stats.userHandle) || "seanmega").replace(/^@+/, ""));
  const activeAccounts = normalizeCount(stats.activeAccounts);
  const running = normalizeCount(stats.running);
  const paused = normalizeCount(stats.paused);
  const stopped = normalizeCount(stats.stopped);
  const crashed = normalizeCount(stats.crashed);
  const banned = normalizeCount(stats.banned);
  const queue = normalizeCount(stats.queue);
  const proxyHealth = normalizeCount(stats.proxyHealth);
  const lastUpdate = escapeHtml(formatPanelTime(stats.lastUpdate || new Date()));

  return [
    "\u2705 Proxy &amp; User-Agent verified",
    "\uD83D\uDE80 SeanBoost Manager",
    "",
    `\uD83D\uDC64 User: ${userName} (@${userHandle})`,
    `\uD83D\uDCCA Active Accounts: ${activeAccounts}`,
    `\u25B6\uFE0F Running: ${running}   \u23F8 Paused: ${paused}   \uD83D\uDED1 Stopped: ${stopped}`,
    `\u274C Crashed: ${crashed}   \uD83D\uDEAB Banned: ${banned}`,
    `\uD83E\uDDFE Queue: ${queue}   \uD83E\uDE7A Proxy Health: ${proxyHealth}%`,
    `\uD83D\uDD52 Last Update: ${lastUpdate}`
  ].join("\n");
}

function buildPanelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "\u23F8 Pause", callback_data: "pause_one" },
        { text: "\u25B6\uFE0F Resume", callback_data: "resume_one" }
      ],
      [
        { text: "\u23F8 Pause all", callback_data: "pause_all" },
        { text: "\u25B6\uFE0F Resume all", callback_data: "resume_all" }
      ]
    ]
  };
}

function toPickerStatusLabel(account) {
  const status = normalizeString(account?.status).toLowerCase();
  if (!status) return "unknown";
  return status;
}

function buildAccountPickerKeyboard(mode, accounts = []) {
  const action = normalizeString(mode).toLowerCase() === "resume" ? "resume" : "pause";

  const rows = accounts
    .filter((account) => account && account._id && account.email)
    .map((account) => [{
      text: `${String(account.email)} | ${toPickerStatusLabel(account)}`,
      callback_data: `${action}:${String(account._id)}`
    }]);

  return {
    inline_keyboard: rows
  };
}

module.exports = {
  buildPanelText,
  buildPanelKeyboard,
  buildAccountPickerKeyboard,
  formatPanelTime
};

