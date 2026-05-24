const TelegramBot = require("node-telegram-bot-api");
const Account = require("../../model/Account");
const User = require("../../model/User");
const workerManager = require("../../engine/workerGateway");
const { emitAccountUpdateEvent } = require("../../internal/eventBridge");
const { getOrCreateAppSettings } = require("../../utils/appSettings");
const { formatDateTimeForAdmin } = require("../../utils/timing");
const { isValidTelegramChatId, isValidTelegramToken, maskTelegramToken } = require("../../utils/telegram");
const { TelegramSettings } = require("../../model/TelegramSettings");
const {
  DEFAULT_ACCOUNT_PROJECTION,
  getAccountAliasDisplay,
  getTelegramGroupBinding,
  resolveAccountTarget,
  removeTelegramGroupBinding,
  bindTelegramGroupToAccount
} = require("./accountResolver");
const {
  buildPanelText,
  buildPanelKeyboard,
  buildAccountPickerKeyboard,
  formatPanelTime
} = require("./panel");
const { t, translateStatus, translateWorker, normalizeLang } = require("./i18n");

const ACTION_COOLDOWN_MS = 2000;
const REFRESH_SETTINGS_INTERVAL_MS = 30000;
const MAX_PICKER_ACCOUNTS = 10;
const ACTION_IP = "telegram-panel";
const SINGLE_ACCOUNT_CALLBACK_PREFIX = "tgacct";
const TELEGRAM_ACCOUNT_LOG_PREFIX = "[TG-ACCOUNT]";
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

async function getUserLanguage(userIdInput) {
  const userId = normalizeString(userIdInput);
  if (!userId) return "en";
  const user = await User.findById(userId).select("language").lean().catch(() => null);
  return normalizeLang(user?.language);
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

function shouldRefreshPanelMessage(chatId, settings) {
  return isAuthorizedChat(chatId, settings);
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

function normalizeUsername(value) {
  return normalizeString(value).replace(/^@+/, "").toLowerCase();
}

function parseAdminEntries(raw) {
  return new Set(
    String(raw || "")
      .split(/[\s,]+/)
      .map((value) => normalizeString(value))
      .filter(Boolean)
  );
}

async function loadAppSettings(userIdInput) {
  const userId = normalizeString(userIdInput);
  if (!userId) {
    return null;
  }

  return getOrCreateAppSettings(userId).catch(() => null);
}

async function isSenderTelegramAdmin(bot, chatIdInput, fromIdInput) {
  const chatId = normalizeString(chatIdInput);
  const fromId = normalizeString(fromIdInput);
  if (!bot || !chatId || !fromId) {
    return false;
  }

  try {
    const admins = await bot.getChatAdministrators(chatId);
    return admins.some((entry) => normalizeString(entry?.user?.id) === fromId);
  } catch {
    return false;
  }
}

async function ensureAuthorizedSender(bot, source, userIdInput, options = {}) {
  const appSettings = await loadAppSettings(userIdInput);
  const allowedIds = parseAdminEntries(appSettings?.telegramAdminIds);
  const allowedUsernames = new Set(
    Array.from(parseAdminEntries(appSettings?.telegramAdminUsernames)).map((value) =>
      normalizeUsername(value)
    )
  );
  const hasConfiguredAdmins = allowedIds.size > 0 || allowedUsernames.size > 0;

  const fromId = normalizeString(source?.from?.id);
  const username = normalizeUsername(source?.from?.username);
  const chatId = normalizeString(source?.chat?.id || source?.message?.chat?.id);
  const chatType = normalizeString(source?.chat?.type || source?.message?.chat?.type).toLowerCase();

  const matchesConfiguredAdmin =
    (fromId && allowedIds.has(fromId)) || (username && allowedUsernames.has(username));
  if (matchesConfiguredAdmin) {
    return {
      ok: true,
      appSettings
    };
  }

  const requireAdmin = Boolean(options?.requireAdmin);
  const canCheckGroupAdmins = (chatType === "group" || chatType === "supergroup") && fromId;
  if ((requireAdmin || hasConfiguredAdmins) && canCheckGroupAdmins) {
    const isGroupAdmin = await isSenderTelegramAdmin(bot, chatId, fromId);
    if (isGroupAdmin) {
      return {
        ok: true,
        appSettings
      };
    }
  }

  if (!requireAdmin && !hasConfiguredAdmins) {
    return {
      ok: true,
      appSettings
    };
  }

  const lang = options?.lang || "en";
  return {
    ok: false,
    status: 403,
    message: requireAdmin ? t(lang, "err_admin_only") : t(lang, "err_not_authorized"),
    appSettings
  };
}

function buildProxyLabel(account = {}) {
  const proxyIp = normalizeString(account?.connectionTest?.proxyIp);
  if (proxyIp) {
    return proxyIp;
  }

  const host = normalizeString(account?.proxyHost);
  const port = normalizeString(account?.proxyPort);
  if (host && port) {
    return `${host}:${port}`;
  }

  return host || "-";
}

function resolveNextBumpTimestamp(account, debugSnapshot) {
  return (
    debugSnapshot?.nextScheduledAt ||
    account?.nextBumpAt ||
    account?.waitingUntil ||
    account?.workerState?.nextRetryAt ||
    null
  );
}

function resolveWorkerHealthLabel(account, debugSnapshot) {
  const status = toLower(debugSnapshot?.status || account?.status);
  if (status === "blocked" || status === "banned" || normalizeString(account?.workerState?.blockedReason)) {
    return "blocked";
  }
  if (status === "stalled" || debugSnapshot?.stallAlertOpen) {
    return "stalled";
  }
  if (status === "error" || status === "crashed") {
    return "crashed";
  }
  if (debugSnapshot?.waitingForRecovery) {
    return "recovering";
  }
  if (Number(debugSnapshot?.consecutiveFailures || 0) > 0) {
    return "degraded";
  }
  if (debugSnapshot) {
    return "healthy";
  }
  if (isRunningStatus(status)) {
    return "healthy";
  }
  return status || "unknown";
}

function buildSingleAccountKeyboard(accountIdInput, lang = "en") {
  const accountId = normalizeString(accountIdInput);
  if (!accountId) {
    return undefined;
  }

  return {
    inline_keyboard: [
      [
        {
          text: t(lang, "btn_pause"),
          callback_data: `${SINGLE_ACCOUNT_CALLBACK_PREFIX}:pause:${accountId}`
        },
        {
          text: t(lang, "btn_resume"),
          callback_data: `${SINGLE_ACCOUNT_CALLBACK_PREFIX}:resume:${accountId}`
        }
      ],
      [
        {
          text: t(lang, "btn_restart"),
          callback_data: `${SINGLE_ACCOUNT_CALLBACK_PREFIX}:restart:${accountId}`
        }
      ]
    ]
  };
}

async function buildSingleAccountStatusView(account, userIdInput, options = {}) {
  const userId = normalizeString(userIdInput || account?.userId);
  const lang = options?.lang || (await getUserLanguage(userId));
  const appSettings = options?.appSettings || (await loadAppSettings(userId));
  const debugSnapshot =
    options?.debugSnapshot ||
    (await workerManager.getWorkerDebugSnapshot(account?._id, { userId }).catch(() => null));

  const nextBumpAt = resolveNextBumpTimestamp(account, debugSnapshot);
  const lastBumpAt = account?.lastBumpAt || debugSnapshot?.lastSuccessfulTaskAt || null;
  const workerHealth = resolveWorkerHealthLabel(account, debugSnapshot);
  const status = normalizeString(debugSnapshot?.status || account?.status || "unknown");

  const lines = [
    t(lang, "acc_control"),
    `${t(lang, "acc_email")}: ${normalizeString(account?.email) || "-"}`,
    `${t(lang, "acc_id")}: ${normalizeString(account?._id) || "-"}`,
    `${t(lang, "acc_status")}: ${status ? translateStatus(lang, status) : "-"}`,
    `${t(lang, "acc_proxy")}: ${buildProxyLabel(account)}`,
    `${t(lang, "acc_next_bump")}: ${
      nextBumpAt ? formatDateTimeForAdmin(nextBumpAt, appSettings, { includeDate: false }) : "-"
    }`,
    `${t(lang, "acc_total_bumps")}: ${Number(account?.totalBumpsToday || 0)}`,
    `${t(lang, "acc_worker")}: ${translateWorker(lang, workerHealth)}`
  ];

  if (lastBumpAt) {
    lines.push(
      `${t(lang, "acc_last_bump")}: ${formatDateTimeForAdmin(lastBumpAt, appSettings, {
        includeDate: true
      })}`
    );
  }

  if (normalizeString(debugSnapshot?.currentStep)) {
    lines.push(`${t(lang, "acc_step")}: ${normalizeString(debugSnapshot.currentStep)}`);
  }

  return {
    text: lines.join("\n"),
    replyMarkup: buildSingleAccountKeyboard(account?._id, lang),
    parseMode: undefined,
    appSettings,
    debugSnapshot,
    lang
  };
}

async function buildBoundAccountView(settings, options = {}) {
  const userId = getScopedUserId(settings);
  const chatId = normalizeString(options?.chatId || settings?.chatId);
  if (!userId || !chatId) {
    return null;
  }

  const lang = options?.lang || (await getUserLanguage(userId));

  const binding = await getTelegramGroupBinding({
    userId,
    chatId
  });
  if (!binding) {
    return null;
  }

  try {
    const resolved = await resolveAccountTarget({
      userId,
      chatId,
      strictBinding: true,
      projection: DEFAULT_ACCOUNT_PROJECTION
    });

    const view = await buildSingleAccountStatusView(resolved.account, userId, {
      appSettings: options?.appSettings,
      lang
    });

    return {
      ...view,
      binding,
      account: resolved.account
    };
  } catch (error) {
    return {
      text: String(error?.message || t(lang, "bind_unavailable")),
      replyMarkup: undefined,
      parseMode: undefined,
      binding
    };
  }
}

function buildGlobalPanelView(stats, lang = "en") {
  return {
    text: buildPanelText(stats, lang),
    replyMarkup: buildPanelKeyboard(lang),
    parseMode: "HTML"
  };
}

function buildSingleAccountUsageText(command, lang = "en") {
  const action = normalizeString(command || "status") || "status";
  return [
    t(lang, "usage_target_required"),
    t(lang, "usage_use_email", { a: action }),
    t(lang, "usage_use_id", { a: action }),
    t(lang, "usage_bind_hint")
  ].join("\n");
}

async function safeAnswerCallback(bot, queryId, text) {
  if (!bot || !queryId) return;

  try {
    await bot.answerCallbackQuery(queryId, {
      text: (normalizeString(text) || "Done").slice(0, 180),
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

  const chatId = normalizeString(options?.chatId || settings?.chatId);
  if (!chatId) {
    return {
      ok: false,
      reason: "chat_not_configured"
    };
  }

  const lang = options?.lang || (await getUserLanguage(getScopedUserId(settings)));
  const boundView = await buildBoundAccountView(settings, {
    chatId,
    appSettings: options?.appSettings,
    lang
  });
  const panelView = boundView || buildGlobalPanelView(await buildPanelStats(settings), lang);
  const text = panelView.text;
  const replyMarkup =
    options?.replyMarkup !== undefined ? options.replyMarkup : panelView.replyMarkup;
  const parseMode =
    options?.parseMode !== undefined ? options.parseMode : panelView.parseMode;
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
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
        ...(parseMode ? { parse_mode: parseMode } : {})
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
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
    ...(parseMode ? { parse_mode: parseMode } : {})
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

  await workerManager.pauseAccount(accountId, {
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

  await workerManager.resumeAccount(accountId, {
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

async function setAccountRestarted(account) {
  const accountId = String(account?._id || "");
  if (!accountId) {
    throw new Error("Account not found");
  }

  if (isBannedStatus(account?.status) || normalizeString(account?.workerState?.blockedReason)) {
    throw new Error("Cannot restart blocked/banned account");
  }

  const userId = normalizeString(account?.userId);

  await workerManager.restartAccount(account, {
    userId,
    ip: ACTION_IP,
    stopTimeoutMs: 5000,
    restartDelayMs: 3000
  });
}

async function loadScopedAccountById(accountId, userId) {
  const normalizedAccountId = normalizeString(accountId);
  if (!normalizedAccountId) {
    return null;
  }

  return Account.findOne({
    _id: normalizedAccountId,
    userId: normalizeString(userId)
  })
    .select(DEFAULT_ACCOUNT_PROJECTION)
    .lean();
}

async function editSingleAccountMessage(bot, message, userId, account) {
  const chatId = normalizeString(message?.chat?.id);
  const messageId = Number(message?.message_id || 0);
  if (!bot || !chatId || !messageId || !account?._id) {
    return;
  }

  const view = await buildSingleAccountStatusView(account, userId);
  try {
    await bot.editMessageText(view.text, {
      chat_id: chatId,
      message_id: messageId,
      disable_web_page_preview: true,
      reply_markup: view.replyMarkup
    });
  } catch (error) {
    if (!isMessageNotModified(error)) {
      throw error;
    }
  }
}

async function sendSingleAccountStatus(bot, chatIdInput, account, userId) {
  const chatId = normalizeString(chatIdInput);
  if (!bot || !chatId || !account?._id) {
    return null;
  }

  const view = await buildSingleAccountStatusView(account, userId);
  return bot.sendMessage(chatId, view.text, {
    disable_web_page_preview: true,
    reply_markup: view.replyMarkup
  });
}

function parseTargetArgument(text, command) {
  const rawText = normalizeString(text);
  if (!rawText) {
    return "";
  }

  const botCommandPattern = new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?`, "i");
  return rawText.replace(botCommandPattern, "").trim();
}

async function resolveTelegramCommandAccount(userId, chatId, rawTarget, command, lang = "en") {
  try {
    return await resolveAccountTarget({
      userId,
      chatId,
      rawTarget,
      strictBinding: true,
      projection: DEFAULT_ACCOUNT_PROJECTION
    });
  } catch (error) {
    if (error?.code === "missing_target") {
      error.message = buildSingleAccountUsageText(command, lang);
    }
    throw error;
  }
}

async function performTelegramAccountAction(action, account, lang = "en") {
  const normalizedAction = normalizeString(action).toLowerCase();
  if (normalizedAction === "pause") {
    await setAccountPaused(account);
    return t(lang, "act_paused");
  }

  if (normalizedAction === "resume") {
    await setAccountResumed(account);
    return t(lang, "act_resumed");
  }

  if (normalizedAction === "restart") {
    await setAccountRestarted(account);
    return t(lang, "act_restart_requested");
  }

  throw new Error("Unsupported Telegram account action");
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

async function ensureAuthorizedSettings(chatId, settings, options = {}) {
  const lang = options?.lang || "en";
  const token = normalizeString(settings?.botToken);
  const savedChatId = normalizeString(settings?.chatId);

  if (!isValidTelegramToken(token) || !isValidTelegramChatId(savedChatId)) {
    return {
      ok: false,
      status: 400,
      message: t(lang, "err_not_configured"),
      settings
    };
  }

  let authorized = isAuthorizedChat(chatId, settings);
  if (!authorized && options?.allowBoundChat !== false) {
    const binding = await getTelegramGroupBinding({
      userId: getScopedUserId(settings),
      chatId
    }).catch(() => null);
    authorized = Boolean(binding);
  }

  if (!authorized) {
    return {
      ok: false,
      status: 403,
      message: t(lang, "err_not_authorized"),
      settings
    };
  }

  if (!getScopedUserId(settings)) {
    return {
      ok: false,
      status: 400,
      message: t(lang, "err_scope_missing"),
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
  const lang = await getUserLanguage(userId);
  const senderAuth = await ensureAuthorizedSender(bot, message, userId, { lang });
  if (!senderAuth.ok) {
    await bot.sendMessage(chatId, senderAuth.message || t(lang, "err_not_authorized")).catch(() => null);
    return;
  }

  const auth = await ensureAuthorizedSettings(chatId, settings, { lang });
  if (!auth.ok) {
    await bot.sendMessage(chatId, auth.message || t(lang, "err_not_authorized")).catch(() => null);
    return;
  }

  if (!shouldRefreshPanelMessage(chatId, auth.settings)) {
    try {
      const resolved = await resolveAccountTarget({
        userId: getScopedUserId(auth.settings),
        chatId,
        strictBinding: true,
        projection: DEFAULT_ACCOUNT_PROJECTION
      });
      await sendSingleAccountStatus(bot, chatId, resolved.account, getScopedUserId(auth.settings)).catch(() => null);
      return;
    } catch (error) {
      await bot.sendMessage(chatId, String(error?.message || t(lang, "err_not_authorized"))).catch(() => null);
      return;
    }
  }

  await upsertPanelMessage(bot, auth.settings, {
    forceRepost: true,
    chatId,
    appSettings: senderAuth.appSettings,
    lang
  });
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

  const restartMatch = raw.match(/^restart:([a-fA-F0-9]{24})$/);
  if (restartMatch) {
    return {
      mode: "restart",
      accountId: restartMatch[1]
    };
  }

  return null;
}

function extractSingleAccountCallbackAction(data) {
  const raw = normalizeString(data);
  if (!raw) return null;

  const match = raw.match(
    new RegExp(`^${SINGLE_ACCOUNT_CALLBACK_PREFIX}:(pause|resume|restart):([a-fA-F0-9]{24})$`)
  );
  if (!match) {
    return null;
  }

  return {
    mode: match[1],
    accountId: match[2]
  };
}

async function showAccountPicker(bot, query, mode, settings) {
  const chatId = normalizeString(query?.message?.chat?.id);
  const messageId = Number(query?.message?.message_id || 0);

  if (!bot || !chatId || !messageId) return;

  const lang = await getUserLanguage(getScopedUserId(settings));
  const accounts = await listPickerAccounts(settings);
  if (!accounts.length) {
    await safeAnswerCallback(bot, query.id, t(lang, "cb_no_accounts"));
    return;
  }

  await bot
    .editMessageReplyMarkup(buildAccountPickerKeyboard(mode, accounts, lang), {
      chat_id: chatId,
      message_id: messageId
    })
    .catch((error) => {
      if (!isMessageNotModified(error)) {
        throw error;
      }
    });

  const pickerMessage =
    mode === "pause"
      ? t(lang, "cb_pick_pause")
      : mode === "restart"
        ? t(lang, "cb_pick_restart")
        : t(lang, "cb_pick_resume");
  await safeAnswerCallback(bot, query.id, pickerMessage);

  if (!settings.panelMessageId || Number(settings.panelMessageId) !== messageId) {
    settings.panelMessageId = messageId;
    await patchTelegramSettingsByUserId(getScopedUserId(settings), { panelMessageId: messageId }).catch(() => null);
  }
}

async function handleAccountAction(bot, query, action, settings) {
  const scopedUserId = getScopedUserId(settings);
  const chatId = normalizeString(query?.message?.chat?.id);
  const lang = await getUserLanguage(scopedUserId);

  let account = null;
  try {
    const resolved = await resolveAccountTarget({
      userId: scopedUserId,
      chatId,
      rawTarget: action.accountId,
      strictBinding: true,
      projection: DEFAULT_ACCOUNT_PROJECTION
    });
    account = resolved.account;
  } catch (error) {
    await safeAnswerCallback(bot, query.id, String(error?.message || t(lang, "err_account_not_found")));
    if (shouldRefreshPanelMessage(chatId, settings)) {
      await upsertPanelMessage(bot, settings, { chatId, lang });
    }
    return;
  }

  if (action.mode === "pause") {
    console.log(`${TELEGRAM_ACCOUNT_LOG_PREFIX} Pause requested for ${String(account._id)}`);
    await setAccountPaused(account);
    await safeAnswerCallback(bot, query.id, t(lang, "cb_paused"));
  } else if (action.mode === "restart") {
    console.log(`${TELEGRAM_ACCOUNT_LOG_PREFIX} Restart requested for ${String(account._id)}`);
    await setAccountRestarted(account);
    await safeAnswerCallback(bot, query.id, t(lang, "cb_restart_requested"));
  } else {
    console.log(`${TELEGRAM_ACCOUNT_LOG_PREFIX} Resume requested for ${String(account._id)}`);
    await setAccountResumed(account);
    await safeAnswerCallback(bot, query.id, t(lang, "cb_resumed"));
  }

  if (shouldRefreshPanelMessage(chatId, settings)) {
    await upsertPanelMessage(bot, settings, { chatId, lang });
  }
}

async function handleCallbackQuery(bot, query, userId, cooldownByChatId) {
  if (!bot) return;

  const data = normalizeString(query?.data);
  const chatId = normalizeString(query?.message?.chat?.id);
  const lang = await getUserLanguage(userId);

  const settings = await getOrCreateTelegramSettings(userId);
  const auth = await ensureAuthorizedSettings(chatId, settings, { lang });
  if (!auth.ok) {
    await safeAnswerCallback(bot, query?.id, auth.message || t(lang, "err_not_authorized"));
    return;
  }

  const senderAuth = await ensureAuthorizedSender(bot, query, userId, { lang });
  if (!senderAuth.ok) {
    await safeAnswerCallback(bot, query?.id, senderAuth.message || t(lang, "err_not_authorized"));
    return;
  }

  const scopedSettings = auth.settings;
  const scopedUserId = getScopedUserId(scopedSettings);
  const binding = await getTelegramGroupBinding({
    userId: scopedUserId,
    chatId
  }).catch(() => null);

  const singleAccountAction = extractSingleAccountCallbackAction(data);
  const action = extractAccountAction(data);
  const requiresCooldown =
    data === "pause_one" ||
    data === "resume_one" ||
    data === "restart_one" ||
    data === "pause_all" ||
    data === "resume_all" ||
    Boolean(singleAccountAction) ||
    Boolean(action);
  if (requiresCooldown && !consumeActionCooldown(cooldownByChatId, chatId)) {
    await safeAnswerCallback(bot, query?.id, t(lang, "cb_wait"));
    return;
  }

  try {
    if (
      binding &&
      (data === "pause_one" ||
        data === "resume_one" ||
        data === "restart_one" ||
        data === "pause_all" ||
        data === "resume_all")
    ) {
      const resolved = await resolveAccountTarget({
        userId: scopedUserId,
        chatId,
        strictBinding: true,
        projection: DEFAULT_ACCOUNT_PROJECTION
      }).catch(() => null);
      await safeAnswerCallback(
        bot,
        query.id,
        t(lang, "cb_bound_only", {
          x: getAccountAliasDisplay(resolved?.account, { fallbackToEmail: true })
        })
      );
      if (shouldRefreshPanelMessage(chatId, scopedSettings)) {
        await upsertPanelMessage(bot, scopedSettings, {
          chatId,
          appSettings: senderAuth.appSettings,
          lang
        }).catch(() => null);
      }
      return;
    }

    if (singleAccountAction) {
      const resolved = await resolveAccountTarget({
        userId: scopedUserId,
        chatId,
        rawTarget: singleAccountAction.accountId,
        strictBinding: true,
        projection: DEFAULT_ACCOUNT_PROJECTION
      });
      const account = resolved.account;
      const responsePrefix = await performTelegramAccountAction(singleAccountAction.mode, account, lang);

      if (singleAccountAction.mode === "pause") {
        console.log(`${TELEGRAM_ACCOUNT_LOG_PREFIX} Pause requested for ${String(account._id)}`);
      } else if (singleAccountAction.mode === "resume") {
        console.log(`${TELEGRAM_ACCOUNT_LOG_PREFIX} Resume requested for ${String(account._id)}`);
      } else if (singleAccountAction.mode === "restart") {
        console.log(`${TELEGRAM_ACCOUNT_LOG_PREFIX} Restart requested for ${String(account._id)}`);
      }

      await safeAnswerCallback(
        bot,
        query.id,
        `${responsePrefix} ${getAccountAliasDisplay(account, { fallbackToEmail: true })}`
      );

      const freshAccount =
        (await loadScopedAccountById(account._id, scopedUserId).catch(() => null)) || account;
      await editSingleAccountMessage(bot, query.message, scopedUserId, freshAccount).catch(() => null);
      if (shouldRefreshPanelMessage(chatId, scopedSettings)) {
        await upsertPanelMessage(bot, scopedSettings, {
          chatId,
          appSettings: senderAuth.appSettings,
          lang
        }).catch(() => null);
      }
      return;
    }

    if (data === "pause_one") {
      await showAccountPicker(bot, query, "pause", scopedSettings);
      return;
    }

    if (data === "resume_one") {
      await showAccountPicker(bot, query, "resume", scopedSettings);
      return;
    }

    if (data === "restart_one") {
      await showAccountPicker(bot, query, "restart", scopedSettings);
      return;
    }

    if (data === "pause_all") {
      const summary = await pauseAllAccounts(scopedSettings);
      await safeAnswerCallback(
        bot,
        query.id,
        t(lang, "cb_paused_summary", { n: summary.paused, m: summary.alreadyPaused })
      );
      if (shouldRefreshPanelMessage(chatId, scopedSettings)) {
        await upsertPanelMessage(bot, scopedSettings, {
          chatId,
          appSettings: senderAuth.appSettings,
          lang
        });
      }
      return;
    }

    if (data === "resume_all") {
      const summary = await resumeAllAccounts(scopedSettings);
      await safeAnswerCallback(
        bot,
        query.id,
        t(lang, "cb_resumed_summary", { n: summary.resumed, m: summary.alreadyRunning })
      );
      if (shouldRefreshPanelMessage(chatId, scopedSettings)) {
        await upsertPanelMessage(bot, scopedSettings, {
          chatId,
          appSettings: senderAuth.appSettings,
          lang
        });
      }
      return;
    }

    if (action) {
      await handleAccountAction(bot, query, action, scopedSettings);
      return;
    }

    await safeAnswerCallback(bot, query.id, t(lang, "cb_unsupported"));
  } catch (error) {
    console.error("[TELEGRAM-PANEL] Callback action failed:", error?.stack || error?.message || error);
    await safeAnswerCallback(bot, query?.id, String(error?.message || t(lang, "cb_action_failed")).slice(0, 180));
    if (shouldRefreshPanelMessage(chatId, scopedSettings)) {
      await upsertPanelMessage(bot, scopedSettings, {
        chatId,
        appSettings: senderAuth.appSettings,
        lang
      }).catch(() => null);
    }
  }
}

async function handleTelegramAccountCommand(bot, message, userId, commandName) {
  if (!bot) return;

  const chatId = normalizeString(message?.chat?.id);
  const settings = await getOrCreateTelegramSettings(userId);
  const lang = await getUserLanguage(userId);
  const normalizedCommand =
    normalizeString(commandName).toLowerCase() === "unpause"
      ? "resume"
      : normalizeString(commandName).toLowerCase();
  const senderAuth = await ensureAuthorizedSender(bot, message, userId, {
    lang,
    requireAdmin: normalizedCommand === "bind_account" || normalizedCommand === "unbind_account"
  });
  if (!senderAuth.ok) {
    await bot.sendMessage(chatId, senderAuth.message || t(lang, "err_not_authorized")).catch(() => null);
    return;
  }

  const auth = await ensureAuthorizedSettings(chatId, settings, { lang });
  const canBindThisChat =
    normalizedCommand === "bind_account" &&
    !auth.ok &&
    Number(auth?.status) === 403 &&
    isValidTelegramToken(settings?.botToken) &&
    isValidTelegramChatId(settings?.chatId) &&
    Boolean(getScopedUserId(settings));
  if (!auth.ok && !canBindThisChat) {
    await bot.sendMessage(chatId, auth.message || t(lang, "err_not_authorized")).catch(() => null);
    return;
  }

  const scopedSettings = auth.ok ? auth.settings : settings;
  const scopedUserId = getScopedUserId(scopedSettings);
  const rawTarget = parseTargetArgument(message?.text, normalizeString(commandName).toLowerCase());

  try {
    if (normalizedCommand === "bind_account") {
      if (!rawTarget) {
        await bot
          .sendMessage(chatId, t(lang, "bind_usage"))
          .catch(() => null);
        return;
      }

      const resolved = await resolveAccountTarget({
        userId: scopedUserId,
        chatId,
        rawTarget,
        strictBinding: false,
        projection: DEFAULT_ACCOUNT_PROJECTION
      });

      await bindTelegramGroupToAccount({
        userId: scopedUserId,
        chatId,
        accountId: resolved.account._id
      });

      console.log(
        `${TELEGRAM_ACCOUNT_LOG_PREFIX} Bound group ${chatId} -> ${String(resolved.account._id)}`
      );

      await bot
        .sendMessage(
          chatId,
          t(lang, "bind_ok", {
            x: getAccountAliasDisplay(resolved.account, { fallbackToEmail: true })
          })
        )
        .catch(() => null);

      if (shouldRefreshPanelMessage(chatId, scopedSettings)) {
        await upsertPanelMessage(bot, scopedSettings, {
          forceRepost: true,
          chatId,
          appSettings: senderAuth.appSettings,
          lang
        }).catch(() => null);
      } else {
        await sendSingleAccountStatus(bot, chatId, resolved.account, scopedUserId).catch(() => null);
      }
      return;
    }

    if (normalizedCommand === "unbind_account") {
      const binding = await getTelegramGroupBinding({
        userId: scopedUserId,
        chatId
      });
      if (!binding) {
        await bot.sendMessage(chatId, t(lang, "bind_none")).catch(() => null);
        return;
      }

      await removeTelegramGroupBinding({
        userId: scopedUserId,
        chatId
      });

      console.log(`${TELEGRAM_ACCOUNT_LOG_PREFIX} Unbound group ${chatId}`);

      await bot.sendMessage(chatId, t(lang, "unbind_ok")).catch(() => null);
      if (shouldRefreshPanelMessage(chatId, scopedSettings)) {
        await upsertPanelMessage(bot, scopedSettings, {
          forceRepost: true,
          chatId,
          appSettings: senderAuth.appSettings,
          lang
        }).catch(() => null);
      }
      return;
    }

    if (normalizedCommand === "bound_account") {
      const binding = await getTelegramGroupBinding({
        userId: scopedUserId,
        chatId
      });
      if (!binding) {
        await bot.sendMessage(chatId, t(lang, "bind_none")).catch(() => null);
        return;
      }

      const resolved = await resolveAccountTarget({
        userId: scopedUserId,
        chatId,
        strictBinding: true,
        projection: DEFAULT_ACCOUNT_PROJECTION
      });
      await sendSingleAccountStatus(bot, chatId, resolved.account, scopedUserId).catch(() => null);
      return;
    }

    const resolved = await resolveTelegramCommandAccount(
      scopedUserId,
      chatId,
      rawTarget,
      normalizedCommand,
      lang
    );
    const account = resolved.account;
    const accountLabel = getAccountAliasDisplay(account, {
      fallbackToEmail: true
    });

    if (normalizedCommand === "status") {
      await sendSingleAccountStatus(bot, chatId, account, scopedUserId).catch(() => null);
      return;
    }

    const responsePrefix = await performTelegramAccountAction(normalizedCommand, account, lang);

    if (normalizedCommand === "pause") {
      console.log(`${TELEGRAM_ACCOUNT_LOG_PREFIX} Pause requested for ${String(account._id)}`);
    } else if (normalizedCommand === "resume") {
      console.log(`${TELEGRAM_ACCOUNT_LOG_PREFIX} Resume requested for ${String(account._id)}`);
    } else if (normalizedCommand === "restart") {
      console.log(`${TELEGRAM_ACCOUNT_LOG_PREFIX} Restart requested for ${String(account._id)}`);
    }

    await bot.sendMessage(chatId, `${responsePrefix} ${accountLabel}`).catch(() => null);
    if (shouldRefreshPanelMessage(chatId, scopedSettings)) {
      await upsertPanelMessage(bot, scopedSettings, {
        chatId,
        appSettings: senderAuth.appSettings,
        lang
      }).catch(() => null);
    }
  } catch (error) {
    await bot.sendMessage(chatId, String(error?.message || t(lang, "err_command_failed"))).catch(() => null);
  }
}

function attachBotHandlers(bot, userId, cooldownByChatId) {
  bot.onText(/^\/(?:start|panel)(?:@[A-Za-z0-9_]+)?(?:\s+.*)?$/i, (message) => {
    handlePanelCommand(bot, message, userId).catch((error) => {
      console.error("[TELEGRAM-PANEL] Panel command failed:", error?.stack || error?.message || error);
    });
  });

  bot.onText(
    /^\/(pause|resume|restart|status|bind_account|unbind_account|bound_account|unpause)(?:@[A-Za-z0-9_]+)?(?:\s+.*)?$/i,
    (message, match) => {
      handleTelegramAccountCommand(bot, message, userId, match?.[1] || "").catch((error) => {
        console.error("[TELEGRAM-PANEL] Account command failed:", error?.stack || error?.message || error);
      });
    }
  );

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
