const TelegramBot = require("node-telegram-bot-api");
const Account = require("../model/Account");
const workerManager = require("../engine/workerGateway");
const { logActivity } = require("../utils/activityLogger");
const { getTelegramControlConfig } = require("./controlSettings");

const COMMAND_RATE_WINDOW_MS = 10_000;
const COMMAND_RATE_MAX = 5;
const STATUS_TABLE_LIMIT = 15;
const COMMAND_ACTOR_IP = "telegram-control";

const runningLikeStatuses = new Set([
  "running",
  "starting",
  "restarting",
  "active",
  "bumping",
  "waiting_cooldown",
  "awaiting_2fa",
  "awaiting_verification_code",
  "needs2fa"
]);

const commandRateByUserId = new Map();

function normalizeString(value) {
  return String(value || "").trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(value, length) {
  const text = String(value || "");
  if (text.length <= length) return text;
  if (length <= 3) return text.slice(0, length);
  return `${text.slice(0, length - 3)}...`;
}

function pad(value, length) {
  const text = String(value || "");
  if (text.length >= length) return text;
  return text + " ".repeat(length - text.length);
}

function formatUtc(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "-";
  return date.toISOString().replace("T", " ").replace(".000Z", "Z");
}

function parseBotCommand(text) {
  const raw = normalizeString(text);
  if (!raw.startsWith("/")) return null;

  const match = raw.match(/^\/([a-z]+)(?:@[a-zA-Z0-9_]+)?(?:\s+(.+))?$/i);
  if (!match) return null;

  return {
    command: String(match[1] || "").toLowerCase(),
    arg: normalizeString(match[2] || "")
  };
}

function consumeCommandRateLimit(senderId) {
  const key = normalizeString(senderId);
  if (!key) return false;

  const now = Date.now();
  const existing = commandRateByUserId.get(key) || [];
  const recent = existing.filter((ts) => now - ts < COMMAND_RATE_WINDOW_MS);

  if (recent.length >= COMMAND_RATE_MAX) {
    commandRateByUserId.set(key, recent);
    return false;
  }

  recent.push(now);
  commandRateByUserId.set(key, recent);
  return true;
}

function isRunningLikeStatus(status) {
  return runningLikeStatuses.has(normalizeString(status).toLowerCase());
}

function isAuthorizedSender(from, config) {
  const senderId = normalizeString(from?.id);
  const senderUsername = normalizeString(from?.username).toLowerCase();

  if (config.adminIds.size > 0 && senderId && config.adminIds.has(senderId)) {
    return true;
  }

  if (
    config.adminUsernames.size > 0 &&
    senderUsername &&
    config.adminUsernames.has(senderUsername)
  ) {
    return true;
  }

  return false;
}

function toRunningSet(workerStatus) {
  const runningAccounts = Array.isArray(workerStatus?.runningAccounts)
    ? workerStatus.runningAccounts
    : [];
  return new Set(runningAccounts.map((value) => String(value)));
}

function toStatusLabel(account, runningSet) {
  const accountId = String(account?._id || "");
  const running = runningSet.has(accountId) || isRunningLikeStatus(account?.status);
  return running ? "RUNNING" : "PAUSED";
}

function formatStatusTable(accounts, runningSet) {
  const emailWidth = 34;
  const statusWidth = 7;
  const runWidth = 20;

  const lines = [];
  lines.push(
    `${pad("email", emailWidth)} | ${pad("status", statusWidth)} | ${pad("lastRunAt", runWidth)}`
  );
  lines.push(`${"-".repeat(emailWidth)}-+-${"-".repeat(statusWidth)}-+-${"-".repeat(runWidth)}`);

  for (const account of accounts) {
    const email = truncate(String(account?.email || ""), emailWidth);
    const status = toStatusLabel(account, runningSet);
    const lastRunAt = formatUtc(account?.lastBumpAt || account?.updatedAt);

    lines.push(
      `${pad(email, emailWidth)} | ${pad(status, statusWidth)} | ${pad(lastRunAt, runWidth)}`
    );
  }

  return lines.join("\n");
}

async function safeSendMessage(bot, chatId, htmlText) {
  const targetChatId = normalizeString(chatId);
  if (!targetChatId) return;

  try {
    await bot.sendMessage(targetChatId, htmlText, {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (error) {
    console.error("[TELEGRAM-CONTROL] Failed to send message:", error.message);
  }
}

async function sendHelp(bot, chatId) {
  await safeSendMessage(
    bot,
    chatId,
    [
      "<b>Telegram Control Commands</b>",
      "<code>/status</code>",
      "<code>/pause all</code>",
      "<code>/resume all</code>",
      "<code>/pause &lt;email&gt;</code>",
      "<code>/resume &lt;email&gt;</code>",
      "<code>/help</code>"
    ].join("\n")
  );
}

async function fetchUserAccounts(userId, limit = 0) {
  const query = Account.find({ userId })
    .select("_id email status lastBumpAt updatedAt workerState waitingUntil nextBumpAt")
    .sort({ createdAt: -1, _id: -1 });

  if (limit > 0) {
    query.limit(limit);
  }

  return query;
}

async function getRunningSetForUser(userId) {
  const workerStatus =
    typeof workerManager.getWorkerStatus === "function"
      ? await workerManager.getWorkerStatus({ userId })
      : null;
  return toRunningSet(workerStatus);
}

async function pauseAccount(account, userId, actorLabel) {
  const accountId = String(account?._id || "");
  if (!accountId) {
    throw new Error("Account ID is required");
  }

  try {
    await workerManager.requestStop(accountId, {
      userId,
      ip: actorLabel
    });
  } catch (error) {
    console.warn(
      `[TELEGRAM-CONTROL] requestStop failed for ${account.email || accountId}: ${error.message}`
    );
  }

  await Account.findByIdAndUpdate(accountId, {
    $set: {
      status: "paused",
      waitingUntil: null,
      nextBumpAt: null,
      nextBumpDelayMs: null,
      cooldownMinutes: null,
      lastCooldownDetected: null,
      "workerState.nextRetryAt": null
    }
  }).lean();

  await logActivity(
    {
      level: "warning",
      message: `Telegram paused account: ${account.email}`,
      ip: actorLabel,
      email: account.email,
      accountId,
      userId,
      metadata: {
        source: "telegram_control",
        action: "pause",
        telegram: false
      }
    },
    {
      telegram: false
    }
  );
}

async function resumeAccount(account, userId, actorLabel) {
  const accountId = String(account?._id || "");
  if (!accountId) {
    throw new Error("Account ID is required");
  }

  await workerManager.requestStart(account, {
    userId,
    ip: actorLabel,
    resetRuntimeFields: true,
    emitPendingConnectionTest: true
  });

  await logActivity(
    {
      level: "info",
      message: `Telegram resumed account: ${account.email}`,
      ip: actorLabel,
      email: account.email,
      accountId,
      userId,
      metadata: {
        source: "telegram_control",
        action: "resume",
        telegram: false
      }
    },
    {
      telegram: false
    }
  );
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeString(value).toLowerCase());
}

async function handleStatusCommand(bot, chatId, userId) {
  const accounts = await fetchUserAccounts(userId, STATUS_TABLE_LIMIT);
  if (!accounts.length) {
    await safeSendMessage(bot, chatId, "No accounts found for Telegram control user.");
    return;
  }

  const runningSet = await getRunningSetForUser(userId);
  const table = formatStatusTable(accounts, runningSet);

  await safeSendMessage(
    bot,
    chatId,
    `<b>Account Status (${accounts.length})</b>\n<pre>${escapeHtml(table)}</pre>`
  );
}

async function handlePauseAllCommand(bot, chatId, userId) {
  const accounts = await fetchUserAccounts(userId);
  if (!accounts.length) {
    await safeSendMessage(bot, chatId, "No accounts found for Telegram control user.");
    return;
  }

  const runningSet = await getRunningSetForUser(userId);

  let pausedCount = 0;
  let alreadyPaused = 0;
  let failed = 0;

  for (const account of accounts) {
    const accountId = String(account._id);
    const running = runningSet.has(accountId) || isRunningLikeStatus(account.status);

    if (!running) {
      alreadyPaused += 1;
      continue;
    }

    try {
      await pauseAccount(account, userId, COMMAND_ACTOR_IP);
      pausedCount += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[TELEGRAM-CONTROL] Failed to pause ${account.email || accountId}: ${error.stack || error.message}`
      );
    }
  }

  const suffix = failed > 0 ? `, failed ${failed}` : "";
  await safeSendMessage(
    bot,
    chatId,
    `Paused ${pausedCount} accounts, already paused ${alreadyPaused}${suffix}`
  );
}

async function handleResumeAllCommand(bot, chatId, userId) {
  const accounts = await fetchUserAccounts(userId);
  if (!accounts.length) {
    await safeSendMessage(bot, chatId, "No accounts found for Telegram control user.");
    return;
  }

  const runningSet = await getRunningSetForUser(userId);

  let resumedCount = 0;
  let alreadyRunning = 0;
  let failed = 0;

  for (const account of accounts) {
    const accountId = String(account._id);
    const running = runningSet.has(accountId) || isRunningLikeStatus(account.status);

    if (running) {
      alreadyRunning += 1;
      continue;
    }

    if (account?.workerState?.blockedReason) {
      failed += 1;
      continue;
    }

    try {
      await resumeAccount(account, userId, COMMAND_ACTOR_IP);
      resumedCount += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[TELEGRAM-CONTROL] Failed to resume ${account.email || accountId}: ${error.stack || error.message}`
      );
    }
  }

  const suffix = failed > 0 ? `, failed ${failed}` : "";
  await safeSendMessage(
    bot,
    chatId,
    `Resumed ${resumedCount} accounts, already running ${alreadyRunning}${suffix}`
  );
}

async function findAccountByEmail(userId, email) {
  const normalized = normalizeString(email).toLowerCase();
  const regex = new RegExp(`^${escapeRegex(normalized)}$`, "i");

  return Account.findOne({ userId, email: regex })
    .select("_id email status workerState")
    .lean();
}

async function handlePauseByEmail(bot, chatId, userId, emailArg) {
  if (!isValidEmail(emailArg)) {
    await safeSendMessage(bot, chatId, "Invalid email format.");
    return;
  }

  const account = await findAccountByEmail(userId, emailArg);
  if (!account) {
    await safeSendMessage(bot, chatId, "Account not found for this user.");
    return;
  }

  const runningSet = await getRunningSetForUser(userId);
  const running = runningSet.has(String(account._id)) || isRunningLikeStatus(account.status);
  if (!running) {
    await safeSendMessage(bot, chatId, `Already paused: ${escapeHtml(account.email)}`);
    return;
  }

  await pauseAccount(account, userId, COMMAND_ACTOR_IP);
  await safeSendMessage(bot, chatId, `Paused: ${escapeHtml(account.email)}`);
}

async function handleResumeByEmail(bot, chatId, userId, emailArg) {
  if (!isValidEmail(emailArg)) {
    await safeSendMessage(bot, chatId, "Invalid email format.");
    return;
  }

  const account = await findAccountByEmail(userId, emailArg);
  if (!account) {
    await safeSendMessage(bot, chatId, "Account not found for this user.");
    return;
  }

  const runningSet = await getRunningSetForUser(userId);
  const running = runningSet.has(String(account._id)) || isRunningLikeStatus(account.status);
  if (running) {
    await safeSendMessage(bot, chatId, `Already running: ${escapeHtml(account.email)}`);
    return;
  }

  if (account?.workerState?.blockedReason) {
    await safeSendMessage(bot, chatId, `Cannot resume blocked account: ${escapeHtml(account.email)}`);
    return;
  }

  await resumeAccount(account, userId, COMMAND_ACTOR_IP);
  await safeSendMessage(bot, chatId, `Resumed: ${escapeHtml(account.email)}`);
}

async function handleIncomingMessage(bot, message) {
  const text = normalizeString(message?.text);
  if (!text.startsWith("/")) {
    return;
  }

  const config = await getTelegramControlConfig();
  const configuredChatId = normalizeString(config.chatId);
  const messageChatId = normalizeString(message?.chat?.id);
  if (!configuredChatId || configuredChatId !== messageChatId) {
    return;
  }

  if (!isAuthorizedSender(message?.from, config)) {
    await safeSendMessage(bot, configuredChatId, "Not authorized.");
    return;
  }

  const senderId = normalizeString(message?.from?.id);
  if (!consumeCommandRateLimit(senderId)) {
    await safeSendMessage(bot, configuredChatId, "Rate limit exceeded. Max 5 commands per 10 seconds.");
    return;
  }

  if (!config.enabled) {
    await safeSendMessage(bot, configuredChatId, "Telegram control is disabled.");
    return;
  }

  if (!config.defaultUser?._id || config.defaultUser.isActive === false) {
    await safeSendMessage(bot, configuredChatId, "Telegram control user is not configured or inactive.");
    return;
  }

  const parsed = parseBotCommand(text);
  if (!parsed) {
    return;
  }

  const { command, arg } = parsed;
  const userId = config.defaultUser._id;

  try {
    if (command === "help") {
      await sendHelp(bot, configuredChatId);
      return;
    }

    if (command === "status") {
      await handleStatusCommand(bot, configuredChatId, userId);
      return;
    }

    if (command === "pause") {
      if (!arg) {
        await safeSendMessage(bot, configuredChatId, "Usage: /pause all OR /pause <email>");
        return;
      }

      if (arg.toLowerCase() === "all") {
        await handlePauseAllCommand(bot, configuredChatId, userId);
        return;
      }

      await handlePauseByEmail(bot, configuredChatId, userId, arg);
      return;
    }

    if (command === "resume") {
      if (!arg) {
        await safeSendMessage(bot, configuredChatId, "Usage: /resume all OR /resume <email>");
        return;
      }

      if (arg.toLowerCase() === "all") {
        await handleResumeAllCommand(bot, configuredChatId, userId);
        return;
      }

      await handleResumeByEmail(bot, configuredChatId, userId, arg);
      return;
    }

    await sendHelp(bot, configuredChatId);
  } catch (error) {
    console.error(`[TELEGRAM-CONTROL] Command failed: ${error.stack || error.message}`);
    const messageText = escapeHtml(error?.message || "Unknown error");
    await safeSendMessage(bot, configuredChatId, `Error: ${messageText}`);
  }
}

async function startTelegramControlBot() {
  const config = await getTelegramControlConfig();

  if (!config.hasTokenConfigured) {
    console.warn("[TELEGRAM-CONTROL] TELEGRAM_BOT_TOKEN is missing or invalid. Bot not started.");
    return {
      started: false,
      reason: "token_not_configured",
      stop: async () => {}
    };
  }

  const bot = new TelegramBot(config.token, {
    polling: {
      autoStart: true,
      params: {
        timeout: 30
      }
    }
  });

  bot.on("message", (message) => {
    handleIncomingMessage(bot, message).catch((error) => {
      console.error(`[TELEGRAM-CONTROL] Message handler failed: ${error.stack || error.message}`);
    });
  });

  bot.on("polling_error", (error) => {
    console.error("[TELEGRAM-CONTROL] Polling error:", error.message || error);
  });

  bot.on("webhook_error", (error) => {
    console.error("[TELEGRAM-CONTROL] Webhook error:", error.message || error);
  });

  console.log("[TELEGRAM-CONTROL] Bot polling started");

  return {
    started: true,
    stop: async () => {
      try {
        await bot.stopPolling({
          cancel: true
        });
      } catch (error) {
        console.error("[TELEGRAM-CONTROL] Failed to stop polling:", error.message);
      }
    }
  };
}

module.exports = {
  startTelegramControlBot
};
