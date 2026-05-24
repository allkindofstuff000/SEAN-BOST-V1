const { t, translateStatus } = require("./i18n");

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

function buildPanelText(stats = {}, lang = "en") {
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
    t(lang, "panel_verified").replace("&", "&amp;"),
    t(lang, "panel_title"),
    "",
    `${t(lang, "panel_user")}: ${userName} (@${userHandle})`,
    `${t(lang, "panel_active")}: ${activeAccounts}`,
    `${t(lang, "panel_running")}: ${running}   ${t(lang, "panel_paused")}: ${paused}   ${t(lang, "panel_stopped")}: ${stopped}`,
    `${t(lang, "panel_crashed")}: ${crashed}   ${t(lang, "panel_banned")}: ${banned}`,
    `${t(lang, "panel_queue")}: ${queue}   ${t(lang, "panel_proxy_health")}: ${proxyHealth}%`,
    `${t(lang, "panel_last_update")}: ${lastUpdate}`
  ].join("\n");
}

function buildPanelKeyboard(lang = "en") {
  return {
    inline_keyboard: [
      [
        { text: t(lang, "btn_pause"), callback_data: "pause_one" },
        { text: t(lang, "btn_resume"), callback_data: "resume_one" }
      ],
      [{ text: t(lang, "btn_restart"), callback_data: "restart_one" }],
      [
        { text: t(lang, "btn_pause_all"), callback_data: "pause_all" },
        { text: t(lang, "btn_resume_all"), callback_data: "resume_all" }
      ]
    ]
  };
}

function toPickerStatusLabel(account, lang = "en") {
  const status = normalizeString(account?.status).toLowerCase();
  if (!status) return translateStatus(lang, "unknown");
  return translateStatus(lang, status);
}

function buildAccountPickerKeyboard(mode, accounts = [], lang = "en") {
  const normalizedMode = normalizeString(mode).toLowerCase();
  const action =
    normalizedMode === "resume"
      ? "resume"
      : normalizedMode === "restart"
        ? "restart"
        : "pause";

  const rows = accounts
    .filter((account) => account && account._id && account.email)
    .map((account) => [{
      text: `${String(account.email)} | ${toPickerStatusLabel(account, lang)}`,
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

