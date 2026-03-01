const TelegramBot = require("node-telegram-bot-api");
const Account = require("../../model/Account");
const User = require("../../model/User");
const workerManager = require("../../engine/workerGateway");
const { emitAccountUpdateEvent } = require("../../internal/eventBridge");
const { isValidTelegramChatId, isValidTelegramToken, maskTelegramToken } = require("../../utils/telegram");
const { TelegramSettings } = require("../../model/TelegramSettings");
const {
  buildPanelText,
  buildPanelKeyboard,
  buildAccountPickerKeyboard,
  formatPanelTime
} = require("./panel");

const ACTION_COOLDOWN_MS = 2000;
const REFRESH_SETTINGS_INTERVAL_MS = 30000;
const MAX_PICKER_ACCOUNTS = 10;
const ACTION_IP = "telegram-panel";
const RUNNING_STATUS_SET = new Set([
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
const CRASHED_STATUS_SET = new Set(["crashed", "error"]);
const BANNED_STATUS_SET = new Set(["banned", "blocked"]);

const DEFAULT_PANEL_USER_NAME = String(process.env.TELEGRAM_PANEL_USER_NAME || "Sean").trim() || "Sean";
const DEFAULT_PANEL_USER_HANDLE =
  String(process.env.TELEGRAM_PANEL_USER_HANDLE || "seanmega").trim().replace(/^@+/, "") ||
  "seanmega";

const runtime = {
  botsByUserId: new Map(),
  refreshTimer: null
};

function normalizeString(value) {
  return String(value || "").trim();
}

function toLower(value) {
  return normalizeString(value).toLowerCase();
}

function getScopedUserId(settings) {
  return normalizeString(settings?.userId);
}

function buildScopedAccountQuery(settings) {
  const userId = getScopedUserId(settings);
  return userId ? { userId } : null;
}

function getErrorMessage(error) {
  return (
    normalizeString(error?.response?.body?.description) ||
    normalizeString(error?.message) ||
    "Unknown Telegram error"
  );
}

function isMessageNotModified(error) {
  return getErrorMessage(error).toLowerCase().includes("message is not modified");
}

function isMessageNotFound(error) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("message to edit not found") ||
    message.includes("message can't be edited") ||
    message.includes("message identifier is not specified")
  );
}

function isAuthorizedChat(chatId, settings) {
  return normalizeString(chatId) === normalizeString(settings?.chatId);
}

function consumeActionCooldown(cooldownByChatId, chatId) {
  const key = normalizeString(chatId);
  if (!key) return false;

  const now = Date.now();
  const last = Number(cooldownByChatId.get(key) || 0);
  if (last > 0 && now - last < ACTION_COOLDOWN_MS) {
    return false;
  }

  cooldownByChatId.set(key, now);
  return true;
}

function isRunningStatus(status) {
  return RUNNING_STATUS_SET.has(toLower(status));
}

function isPausedStatus(status) {
  return toLower(status) === "paused";
}

function isStoppedStatus(status) {
  const normalized = toLower(status);
  return normalized === "stopped" || normalized === "completed";
}

function isCrashedStatus(status) {
  return CRASHED_STATUS_SET.has(toLower(status));
}

function isBannedStatus(status) {
  return BANNED_STATUS_SET.has(toLower(status));
}

async function getOrCreateTelegramSettings(userIdInput) {
  const userId = normalizeString(userIdInput);
  if (!userId) {
    throw new Error("userId is required to load Telegram settings");
  }

  const runUpsert = () =>
    TelegramSettings.findOneAndUpdate(
      { userId },
      {
        $setOnInsert: {
          userId,
          botToken: "",
          chatId: "",
          panelMessageId: null
        }
      },
      {
        upsert: true,
        new: true
      }
    );

  return runUpsert();
}

async function patchTelegramSettingsByUserId(userIdInput, patch = {}) {
  const userId = normalizeString(userIdInput);
  if (!userId) return null;

  const safePatch = patch && typeof patch === "object" ? patch : {};

  return TelegramSettings.findOneAndUpdate(
    { userId },
    {
      $set: {
        userId,
        ...safePatch
      }
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    }
  );
}

async function listConfiguredTelegramSettings() {
  return TelegramSettings.find({
    userId: { $exists: true, $ne: null }
  })
    .select("userId botToken chatId panelMessageId updatedAt")
    .sort({ updatedAt: -1, _id: -1 })
    .lean();
}

function buildSettingsPublicPayload(settings) {
  const token = normalizeString(settings?.botToken);
  const chatId = normalizeString(settings?.chatId);

  return {
    enabled: Boolean(token && chatId),
    chatId,
    hasTokenConfigured: Boolean(token),
    tokenMasked: maskTelegramToken(token),
    panelMessageId: Number(settings?.panelMessageId) || null,
    updatedAt: settings?.updatedAt || null,
    userId: getScopedUserId(settings) || null
  };
}

async function resolvePanelUser(accounts, settings) {
  let userName = DEFAULT_PANEL_USER_NAME;
  let userHandle = DEFAULT_PANEL_USER_HANDLE;

  const scopedUserId = getScopedUserId(settings);
  let user = null;

  if (scopedUserId) {
    user = await User.findById(scopedUserId).select("username").lean().catch(() => null);
  }

  if (!user && accounts.length) {
    const firstUserId = normalizeString(accounts[0]?.userId);
    if (firstUserId) {
      user = await User.findById(firstUserId).select("username").lean().catch(() => null);
    }
  }

  const username = normalizeString(user?.username);
  if (!username) {
    return { userName, userHandle };
  }

  if (!normalizeString(process.env.TELEGRAM_PANEL_USER_NAME)) {
    userName = username;
  }
  if (!normalizeString(process.env.TELEGRAM_PANEL_USER_HANDLE)) {
    userHandle = username.replace(/^@+/, "");
  }

  return { userName, userHandle };
}

function calculateProxyHealth(accounts) {
  const tested = accounts.filter((account) => account?.connectionTest?.testedAt);
  if (tested.length === 0) {
    return 100;
  }

  const successful = tested.filter((account) => account?.connectionTest?.success === true).length;
  return Math.max(0, Math.min(100, Math.round((successful / tested.length) * 100)));
}

async function buildPanelStats(settings) {
  const scopedQuery = buildScopedAccountQuery(settings);
  const query = scopedQuery || {};

  const accounts = await Account.find(query)
    .select("_id userId status connectionTest")
    .sort({ createdAt: -1, _id: -1 })
    .lean();

  let queue = 0;
  try {
    const workerStatus =
      typeof workerManager.getWorkerStatus === "function"
        ? await workerManager.getWorkerStatus(scopedQuery || {})
        : null;
    queue = Number(workerStatus?.queued || 0);
    if (!Number.isFinite(queue) || queue < 0) {
      queue = 0;
    }
  } catch {
    queue = 0;
  }

  let running = 0;
  let paused = 0;
  let stopped = 0;
  let crashed = 0;
  let banned = 0;

  for (const account of accounts) {
    const status = toLower(account?.status);
    if (isRunningStatus(status)) {
      running += 1;
      continue;
    }

    if (isPausedStatus(status)) {
      paused += 1;
      continue;
    }

    if (isStoppedStatus(status)) {
      stopped += 1;
      continue;
    }

    if (isCrashedStatus(status)) {
      crashed += 1;
      continue;
    }

    if (isBannedStatus(status)) {
      banned += 1;
    }
  }

  const panelUser = await resolvePanelUser(accounts, settings);

  return {
    userName: panelUser.userName,
    userHandle: panelUser.userHandle,
    activeAccounts: accounts.length,
    running,
    paused,
    stopped,
    crashed,
    banned,
    queue,
    proxyHealth: calculateProxyHealth(accounts),
    lastUpdate: formatPanelTime(new Date())
  };
}

async function safeAnswerCallback(bot, queryId, text) {
  if (!bot || !queryId) return;

  try {
    await bot.answerCallbackQuery(queryId, {
      text: normalizeString(text) || "Done",
      show_alert: false
    });
  } catch (error) {
    console.error("[TELEGRAM-PANEL] answerCallbackQuery failed:", getErrorMessage(error));
  }
}

async function upsertPanelMessage(bot, settings, options = {}) {
  if (!bot) {
    return {
      ok: false,
      reason: "bot_not_started"
    };
  }

  const chatId = normalizeString(settings?.chatId);
  if (!chatId) {
    return {
      ok: false,
      reason: "chat_not_configured"
    };
  }

  const stats = await buildPanelStats(settings);
  const text = buildPanelText(stats);
  const replyMarkup = options?.replyMarkup || buildPanelKeyboard();
  const forceRepost = Boolean(options?.forceRepost);
  let messageId = Number(settings?.panelMessageId || 0);

  if (forceRepost && messageId > 0) {
    await bot.deleteMessage(chatId, messageId).catch((error) => {
      if (!isMessageNotFound(error)) {
        console.warn("[TELEGRAM-PANEL] Failed to delete previous panel:", getErrorMessage(error));
      }
    });

    messageId = 0;
    settings.panelMessageId = null;
    await patchTelegramSettingsByUserId(getScopedUserId(settings), { panelMessageId: null }).catch(() => null);
  }

  if (messageId > 0) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: replyMarkup
      });

      return {
        ok: true,
        messageId
      };
    } catch (error) {
      if (isMessageNotModified(error)) {
        try {
          await bot.editMessageReplyMarkup(replyMarkup, {
            chat_id: chatId,
            message_id: messageId
          });
        } catch (replyMarkupError) {
          if (!isMessageNotModified(replyMarkupError)) {
            console.error(
              "[TELEGRAM-PANEL] Failed to refresh panel keyboard:",
              getErrorMessage(replyMarkupError)
            );
          }
        }

        return {
          ok: true,
          messageId
        };
      }

      if (!isMessageNotFound(error)) {
        console.error("[TELEGRAM-PANEL] Failed to edit panel:", getErrorMessage(error));
      }
    }
  }

  const sent = await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });

  const panelMessageId = Number(sent?.message_id || 0) || null;
  settings.panelMessageId = panelMessageId;
  await patchTelegramSettingsByUserId(getScopedUserId(settings), { panelMessageId }).catch(() => null);

  return {
    ok: true,
    messageId: panelMessageId
  };
}

async function listPickerAccounts(settings) {
  const scopedQuery = buildScopedAccountQuery(settings);
  const query = scopedQuery || {};

  return Account.find(query)
    .select("_id email status userId workerState")
    .sort({ createdAt: -1, _id: -1 })
    .limit(MAX_PICKER_ACCOUNTS)
    .lean();
}

async function setAccountPaused(account) {
  const accountId = String(account?._id || "");
  if (!accountId) {
    throw new Error("Account not found");
  }

  const userId = normalizeString(account?.userId);

  await workerManager.requestStop(accountId, {
    userId,
    ip: ACTION_IP,
    reason: "telegram_panel_pause",
    forceClearStopRequest: true
  });

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
  }).catch(() => null);

  await emitAccountUpdateEvent(
    accountId,
    {
      status: "paused",
      waitingUntil: null,
      nextBumpAt: null,
      nextBumpDelayMs: null,
      cooldownMinutes: null
    },
    {},
    userId
  ).catch(() => null);
}

async function setAccountResumed(account) {
  const accountId = String(account?._id || "");
  if (!accountId) {
    throw new Error("Account not found");
  }

  if (isBannedStatus(account?.status) || normalizeString(account?.workerState?.blockedReason)) {
    throw new Error("Cannot resume blocked/banned account");
  }

  const userId = normalizeString(account?.userId);

  await workerManager.requestStart(accountId, {
    userId,
    ip: ACTION_IP,
    resetRuntimeFields: true,
    emitPendingConnectionTest: false
  });

  await Account.findByIdAndUpdate(accountId, {
    $set: {
      status: "running",
      waitingUntil: null,
      nextBumpAt: null,
      nextBumpDelayMs: null,
      cooldownMinutes: null,
      lastCooldownDetected: null,
      "workerState.nextRetryAt": null,
      "workerState.blockedReason": null
    }
  }).catch(() => null);

  await emitAccountUpdateEvent(
    accountId,
    {
      status: "running",
      waitingUntil: null,
      nextBumpAt: null,
      nextBumpDelayMs: null,
      cooldownMinutes: null
    },
    {},
    userId
  ).catch(() => null);
}

async function pauseAllAccounts(settings) {
  const scopedQuery = buildScopedAccountQuery(settings);
  const query = scopedQuery || {};

  const accounts = await Account.find(query)
    .select("_id email status userId workerState")
    .lean();

  let paused = 0;
  let alreadyPaused = 0;

  for (const account of accounts) {
    if (!isRunningStatus(account?.status)) {
      alreadyPaused += 1;
      continue;
    }

    await setAccountPaused(account);
    paused += 1;
  }

  return { paused, alreadyPaused };
}

async function resumeAllAccounts(settings) {
  const scopedQuery = buildScopedAccountQuery(settings);
  const query = scopedQuery || {};

  const accounts = await Account.find(query)
    .select("_id email status userId workerState")
    .lean();

  let resumed = 0;
  let alreadyRunning = 0;

  for (const account of accounts) {
    if (isRunningStatus(account?.status)) {
      alreadyRunning += 1;
      continue;
    }

    if (isBannedStatus(account?.status) || normalizeString(account?.workerState?.blockedReason)) {
      continue;
    }

    await setAccountResumed(account);
    resumed += 1;
  }

  return { resumed, alreadyRunning };
}

function ensureAuthorizedSettings(chatId, settings) {
  const token = normalizeString(settings?.botToken);
  const savedChatId = normalizeString(settings?.chatId);

  if (!isValidTelegramToken(token) || !isValidTelegramChatId(savedChatId)) {
    return {
      ok: false,
      status: 400,
      message: "Telegram is not configured.",
      settings
    };
  }

  if (!isAuthorizedChat(chatId, settings)) {
    return {
      ok: false,
      status: 403,
      message: "Not authorized.",
      settings
    };
  }

  if (!getScopedUserId(settings)) {
    return {
      ok: false,
      status: 400,
      message: "Telegram user scope is missing. Save Telegram settings again from your dashboard.",
      settings
    };
  }

  return {
    ok: true,
    settings
  };
}

async function handlePanelCommand(bot, message, userId) {
  if (!bot) return;

  const chatId = normalizeString(message?.chat?.id);
  const settings = await getOrCreateTelegramSettings(userId);
  const auth = ensureAuthorizedSettings(chatId, settings);
  if (!auth.ok) {
    await bot.sendMessage(chatId, auth.message || "Not authorized.").catch(() => null);
    return;
  }

  await upsertPanelMessage(bot, auth.settings, { forceRepost: true });
}

function extractAccountAction(data) {
  const raw = normalizeString(data);
  if (!raw) return null;

  const pauseMatch = raw.match(/^pause:([a-fA-F0-9]{24})$/);
  if (pauseMatch) {
    return {
      mode: "pause",
      accountId: pauseMatch[1]
    };
  }

  const resumeMatch = raw.match(/^resume:([a-fA-F0-9]{24})$/);
  if (resumeMatch) {
    return {
      mode: "resume",
      accountId: resumeMatch[1]
    };
  }

  return null;
}

async function showAccountPicker(bot, query, mode, settings) {
  const chatId = normalizeString(query?.message?.chat?.id);
  const messageId = Number(query?.message?.message_id || 0);

  if (!bot || !chatId || !messageId) return;

  const accounts = await listPickerAccounts(settings);
  if (!accounts.length) {
    await safeAnswerCallback(bot, query.id, "No accounts found.");
    return;
  }

  await bot
    .editMessageReplyMarkup(buildAccountPickerKeyboard(mode, accounts), {
      chat_id: chatId,
      message_id: messageId
    })
    .catch((error) => {
      if (!isMessageNotModified(error)) {
        throw error;
      }
    });

  await safeAnswerCallback(bot, query.id, mode === "pause" ? "Select account to pause" : "Select account to resume");

  if (!settings.panelMessageId || Number(settings.panelMessageId) !== messageId) {
    settings.panelMessageId = messageId;
    await patchTelegramSettingsByUserId(getScopedUserId(settings), { panelMessageId: messageId }).catch(() => null);
  }
}

async function handleAccountAction(bot, query, action, settings) {
  const accountQuery = { _id: action.accountId };
  const scopedUserId = getScopedUserId(settings);
  if (scopedUserId) {
    accountQuery.userId = scopedUserId;
  }

  const account = await Account.findOne(accountQuery)
    .select("_id email status userId workerState")
    .lean();

  if (!account) {
    await safeAnswerCallback(bot, query.id, "Account not found.");
    await upsertPanelMessage(bot, settings);
    return;
  }

  if (action.mode === "pause") {
    await setAccountPaused(account);
    await safeAnswerCallback(bot, query.id, "\u2705 Paused");
  } else {
    await setAccountResumed(account);
    await safeAnswerCallback(bot, query.id, "\u2705 Resumed");
  }

  await upsertPanelMessage(bot, settings);
}

async function handleCallbackQuery(bot, query, userId, cooldownByChatId) {
  if (!bot) return;

  const data = normalizeString(query?.data);
  const chatId = normalizeString(query?.message?.chat?.id);

  const settings = await getOrCreateTelegramSettings(userId);
  const auth = ensureAuthorizedSettings(chatId, settings);
  if (!auth.ok) {
    await safeAnswerCallback(bot, query?.id, auth.message || "Not authorized.");
    return;
  }

  const scopedSettings = auth.settings;

  const action = extractAccountAction(data);
  const requiresCooldown =
    data === "pause_one" ||
    data === "resume_one" ||
    data === "pause_all" ||
    data === "resume_all" ||
    Boolean(action);
  if (requiresCooldown && !consumeActionCooldown(cooldownByChatId, chatId)) {
    await safeAnswerCallback(bot, query?.id, "Please wait 2 seconds.");
    return;
  }

  try {
    if (data === "pause_one") {
      await showAccountPicker(bot, query, "pause", scopedSettings);
      return;
    }

    if (data === "resume_one") {
      await showAccountPicker(bot, query, "resume", scopedSettings);
      return;
    }

    if (data === "pause_all") {
      const summary = await pauseAllAccounts(scopedSettings);
      await safeAnswerCallback(
        bot,
        query.id,
        `\u2705 Paused ${summary.paused}, already paused ${summary.alreadyPaused}`
      );
      await upsertPanelMessage(bot, scopedSettings);
      return;
    }

    if (data === "resume_all") {
      const summary = await resumeAllAccounts(scopedSettings);
      await safeAnswerCallback(
        bot,
        query.id,
        `\u2705 Resumed ${summary.resumed}, already running ${summary.alreadyRunning}`
      );
      await upsertPanelMessage(bot, scopedSettings);
      return;
    }

    if (action) {
      await handleAccountAction(bot, query, action, scopedSettings);
      return;
    }

    await safeAnswerCallback(bot, query.id, "Unsupported action.");
  } catch (error) {
    console.error("[TELEGRAM-PANEL] Callback action failed:", error?.stack || error?.message || error);
    await safeAnswerCallback(bot, query?.id, "Error: action failed");
    await upsertPanelMessage(bot, scopedSettings).catch(() => null);
  }
}

function attachBotHandlers(bot, userId, cooldownByChatId) {
  bot.onText(/^\/(?:start|panel)(?:@[A-Za-z0-9_]+)?(?:\s+.*)?$/i, (message) => {
    handlePanelCommand(bot, message, userId).catch((error) => {
      console.error("[TELEGRAM-PANEL] Panel command failed:", error?.stack || error?.message || error);
    });
  });

  bot.on("callback_query", (query) => {
    handleCallbackQuery(bot, query, userId, cooldownByChatId).catch((error) => {
      console.error("[TELEGRAM-PANEL] callback_query handler failed:", error?.stack || error?.message || error);
    });
  });

  bot.on("polling_error", (error) => {
    console.error(`[TELEGRAM-PANEL] Polling error user=${userId}:`, getErrorMessage(error));
  });
}

async function stopRuntimeForUser(userIdInput) {
  const userId = normalizeString(userIdInput);
  if (!userId) return;

  const entry = runtime.botsByUserId.get(userId);
  if (!entry) return;

  try {
    await entry.bot.stopPolling({ cancel: true });
  } catch (error) {
    console.error("[TELEGRAM-PANEL] Failed to stop polling:", getErrorMessage(error));
  }

  runtime.botsByUserId.delete(userId);
}

async function stopAllRuntimes() {
  const userIds = Array.from(runtime.botsByUserId.keys());
  for (const userId of userIds) {
    await stopRuntimeForUser(userId);
  }
}

function hasDuplicateTokenInActiveRuntimes(userId, token) {
  for (const [otherUserId, entry] of runtime.botsByUserId.entries()) {
    if (otherUserId !== userId && normalizeString(entry?.token) === token) {
      return otherUserId;
    }
  }
  return "";
}

async function ensureRuntimeForSettings(settings, tokenOwners) {
  const userId = getScopedUserId(settings);
  if (!userId) {
    return {
      started: false,
      reason: "missing_user"
    };
  }

  const token = normalizeString(settings?.botToken);
  const chatId = normalizeString(settings?.chatId);

  if (!isValidTelegramToken(token) || !isValidTelegramChatId(chatId)) {
    await stopRuntimeForUser(userId);
    return {
      started: false,
      reason: "not_configured"
    };
  }

  if (tokenOwners) {
    const owner = tokenOwners.get(token);
    if (owner && owner !== userId) {
      await stopRuntimeForUser(userId);
      console.warn(
        `[TELEGRAM-PANEL] Duplicate token detected. user=${userId} ignored because token is already used by user=${owner}`
      );
      return {
        started: false,
        reason: "duplicate_token"
      };
    }
    tokenOwners.set(token, userId);
  } else {
    const duplicateOwner = hasDuplicateTokenInActiveRuntimes(userId, token);
    if (duplicateOwner) {
      await stopRuntimeForUser(userId);
      console.warn(
        `[TELEGRAM-PANEL] Duplicate token detected. user=${userId} ignored because token is already used by user=${duplicateOwner}`
      );
      return {
        started: false,
        reason: "duplicate_token"
      };
    }
  }

  const existing = runtime.botsByUserId.get(userId);
  if (existing && normalizeString(existing.token) === token) {
    existing.chatId = chatId;
    return {
      started: true,
      reason: "already_running"
    };
  }

  await stopRuntimeForUser(userId);

  const bot = new TelegramBot(token, {
    polling: {
      autoStart: true,
      params: {
        timeout: 30
      }
    }
  });

  const cooldownByChatId = new Map();
  attachBotHandlers(bot, userId, cooldownByChatId);

  runtime.botsByUserId.set(userId, {
    bot,
    token,
    chatId,
    cooldownByChatId
  });

  console.log(`[TELEGRAM-PANEL] Bot started user=${userId} token=${maskTelegramToken(token)}`);

  return {
    started: true,
    reason: "configured"
  };
}

async function reloadTelegramBotFromSettings(userIdInput = "") {
  const targetUserId = normalizeString(userIdInput);

  if (targetUserId) {
    const settings = await TelegramSettings.findOne({ userId: targetUserId }).lean();
    if (!settings) {
      await stopRuntimeForUser(targetUserId);
      return {
        started: runtime.botsByUserId.size > 0,
        reason: "not_configured",
        activeBots: runtime.botsByUserId.size
      };
    }

    const result = await ensureRuntimeForSettings(settings, null);
    return {
      started: runtime.botsByUserId.size > 0,
      reason: result.reason,
      activeBots: runtime.botsByUserId.size
    };
  }

  const settingsList = await listConfiguredTelegramSettings();
  const tokenOwners = new Map();
  const desiredUserIds = new Set();

  for (const settings of settingsList) {
    const userId = getScopedUserId(settings);
    if (!userId) {
      continue;
    }

    desiredUserIds.add(userId);
    await ensureRuntimeForSettings(settings, tokenOwners);
  }

  for (const userId of Array.from(runtime.botsByUserId.keys())) {
    if (!desiredUserIds.has(userId)) {
      await stopRuntimeForUser(userId);
    }
  }

  const activeBots = runtime.botsByUserId.size;
  return {
    started: activeBots > 0,
    reason: activeBots > 0 ? "configured" : "not_configured",
    activeBots
  };
}

async function refreshTelegramPanel(userIdInput) {
  const userId = normalizeString(userIdInput);
  if (!userId) {
    return {
      ok: false,
      reason: "missing_user",
      settings: null
    };
  }

  const settings = await getOrCreateTelegramSettings(userId);
  await reloadTelegramBotFromSettings(userId);

  const entry = runtime.botsByUserId.get(userId);
  if (!entry) {
    return {
      ok: false,
      reason: "not_configured",
      settings: buildSettingsPublicPayload(settings)
    };
  }

  const result = await upsertPanelMessage(entry.bot, settings);
  return {
    ok: Boolean(result?.ok),
    messageId: result?.messageId || null,
    settings: buildSettingsPublicPayload(settings)
  };
}

async function startTelegramControlBot() {
  const reloadResult = await reloadTelegramBotFromSettings();

  if (runtime.refreshTimer) {
    clearInterval(runtime.refreshTimer);
    runtime.refreshTimer = null;
  }

  runtime.refreshTimer = setInterval(() => {
    reloadTelegramBotFromSettings().catch((error) => {
      console.error("[TELEGRAM-PANEL] Failed to refresh Telegram settings:", error?.message || error);
    });
  }, REFRESH_SETTINGS_INTERVAL_MS);

  if (typeof runtime.refreshTimer.unref === "function") {
    runtime.refreshTimer.unref();
  }

  return {
    started: Boolean(reloadResult?.started),
    reason: reloadResult?.reason || "unknown",
    stop: async () => {
      if (runtime.refreshTimer) {
        clearInterval(runtime.refreshTimer);
        runtime.refreshTimer = null;
      }

      await stopAllRuntimes();
    }
  };
}

module.exports = {
  startTelegramControlBot,
  reloadTelegramBotFromSettings,
  refreshTelegramPanel,
  getOrCreateTelegramSettings,
  buildSettingsPublicPayload
};
