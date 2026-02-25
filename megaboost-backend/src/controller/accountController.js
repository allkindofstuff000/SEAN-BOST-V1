const Account = require("../model/Account");
const User = require("../model/User");
const mongoose = require("mongoose");
const workerManager = require("../engine/workerGateway");
const { runAccount, testProxyNavigation } = workerManager;
const {
  getCaptchaForAccount,
  refreshCaptchaForAccount,
  submitCaptchaForAccount,
  getVerificationForAccount,
  submitVerificationForAccount,
  getTwoFactorForAccount,
  submitTwoFactorForAccount
} = require("../engine/browserEngine");
const { logActivity, getClientIp } = require("../utils/activityLogger");
const { emitAccountUpdate } = require("../utils/socketEvents");
const { tenantFilter } = require("../utils/tenant");

function getAccountLimit() {
  const limit = Number(process.env.LICENSE_LIMIT || process.env.ACCOUNT_LIMIT || 15);
  return Number.isNaN(limit) || limit < 1 ? 15 : limit;
}

function isAdminRequest(req) {
  return String(req?.user?.role || "").toLowerCase() === "admin";
}

function getScopedFilter(req, baseFilter = {}) {
  return tenantFilter(req, baseFilter);
}

function getLimitFromRequest(req) {
  const fromLicense = Number(req?.license?.maxAccounts);
  if (Number.isFinite(fromLicense) && fromLicense > 0) {
    return Math.floor(fromLicense);
  }
  return getAccountLimit();
}

async function resolveUserAccountLimit(req) {
  if (isAdminRequest(req)) {
    return Number.MAX_SAFE_INTEGER;
  }

  const user = await User.findById(req.user?._id)
    .populate("licenseId")
    .select("licenseId")
    .lean()
    .catch(() => null);
  const license = user?.licenseId;
  if (!license) return 0;

  if (String(license.status || "").toLowerCase() !== "active") return 0;
  const expiresAtTs = new Date(license.expiresAt).valueOf();
  if (Number.isNaN(expiresAtTs) || Date.now() > expiresAtTs) return 0;
  const maxAccounts = Number(license.maxAccounts);
  if (!Number.isFinite(maxAccounts) || maxAccounts < 1) return 0;
  return Math.floor(maxAccounts);
}

async function findScopedAccount(req, accountId, projection = "") {
  const query = Account.findOne(getScopedFilter(req, { _id: accountId }));
  if (projection) {
    query.select(projection);
  }
  return query;
}

function normalizeAccountPayload(payload, options = {}) {
  const data = { ...payload };
  const isUpdate = Boolean(options.isUpdate);
  const hasField = (key) => Object.prototype.hasOwnProperty.call(data, key);

  if (data.proxyString && !data.proxyHost) {
    const [host, port, username, password] = String(data.proxyString).split(":");
    data.proxyHost = host || "";
    data.proxyPort = Number(port) || 0;
    data.proxyUsername = username || "";
    data.proxyPassword = password || "";
  }

  if (!isUpdate || hasField("proxyType")) {
    data.proxyType = String(data.proxyType || "http").trim().toLowerCase();
  }
  if (!isUpdate || hasField("locale")) {
    data.locale = String(data.locale || "en-US").trim() || "en-US";
  }
  if (!isUpdate || hasField("timezone")) {
    data.timezone = data.timezone ? String(data.timezone).trim() : "";
  }

  if (hasField("screenWidth") && data.screenWidth !== undefined && data.screenWidth !== null && data.screenWidth !== "") {
    data.screenWidth = Number(data.screenWidth);
  }
  if (hasField("screenHeight") && data.screenHeight !== undefined && data.screenHeight !== null && data.screenHeight !== "") {
    data.screenHeight = Number(data.screenHeight);
  }

  if (!isUpdate || hasField("maxDailyBumps")) {
    data.maxDailyBumps = Number(isUpdate ? data.maxDailyBumps : data.maxDailyBumps || 10);
  }
  if (!isUpdate || hasField("baseInterval")) {
    data.baseInterval = Number(isUpdate ? data.baseInterval : data.baseInterval || 30);
  }
  if (!isUpdate || hasField("randomMin")) {
    data.randomMin = Number(isUpdate ? data.randomMin : data.randomMin || 0);
  }
  if (!isUpdate || hasField("randomMax")) {
    data.randomMax = Number(isUpdate ? data.randomMax : data.randomMax || 5);
  }
  if (!isUpdate || hasField("maxDailyRuntime")) {
    data.maxDailyRuntime = Number(isUpdate ? data.maxDailyRuntime : data.maxDailyRuntime || 8);
  }

  if (!isUpdate || hasField("autoRestartCrashed")) {
    if (typeof data.autoRestartCrashed !== "boolean") {
      data.autoRestartCrashed = data.autoRestartCrashed !== "false";
    }
  }

  if (!isUpdate || hasField("disableWebRtc")) {
    if (typeof data.disableWebRtc !== "boolean") {
      data.disableWebRtc = data.disableWebRtc !== "false";
    }
  }

  return data;
}

function validateAccountPayload(data) {
  const runtimeWindowPattern = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
  const supportedProxyTypes = new Set(["http", "socks5"]);

  if (!data.email) return "Email is required";
  if (!data.password || String(data.password).length < 6) {
    return "Password must be at least 6 characters";
  }
  if (!supportedProxyTypes.has(String(data.proxyType || ""))) {
    return "Proxy type must be either http or socks5";
  }
  if (!data.proxyHost) return "Proxy host is required";
  if (!data.proxyPort || Number.isNaN(Number(data.proxyPort))) {
    return "Proxy port is required";
  }
  if (Number(data.proxyPort) < 1 || Number(data.proxyPort) > 65535) {
    return "Proxy port must be between 1 and 65535";
  }
  if (data.baseInterval < 1 || data.baseInterval > 1440) {
    return "Base interval must be between 1 and 1440 minutes";
  }
  if (data.maxDailyBumps < 1 || data.maxDailyBumps > 500) {
    return "Max daily bumps must be between 1 and 500";
  }
  if (data.randomMin < 0 || data.randomMax < 0 || data.randomMax < data.randomMin) {
    return "Random range is invalid";
  }
  if (data.maxDailyRuntime < 1 || data.maxDailyRuntime > 24) {
    return "Max daily runtime must be between 1 and 24 hours";
  }
  if (
    data.screenWidth !== undefined &&
    data.screenWidth !== null &&
    data.screenWidth !== "" &&
    (Number.isNaN(Number(data.screenWidth)) ||
      Number(data.screenWidth) < 800 ||
      Number(data.screenWidth) > 3840)
  ) {
    return "Screen width must be between 800 and 3840";
  }
  if (
    data.screenHeight !== undefined &&
    data.screenHeight !== null &&
    data.screenHeight !== "" &&
    (Number.isNaN(Number(data.screenHeight)) ||
      Number(data.screenHeight) < 600 ||
      Number(data.screenHeight) > 2160)
  ) {
    return "Screen height must be between 600 and 2160";
  }
  if (!runtimeWindowPattern.test(String(data.runtimeWindow || ""))) {
    return "Runtime window must be in HH:MM-HH:MM format";
  }

  return null;
}

function ensureDbConnected(res) {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      success: false,
      message: "Database not connected. Please check MONGO_URI/server status."
    });
    return false;
  }
  return true;
}

function sendStructuredEngineError(res, error, fallbackMessage) {
  const status = Number(error?.status);
  const resolvedStatus = Number.isInteger(status) && status >= 400 ? status : 500;
  const payload = error?.payload && typeof error.payload === "object"
    ? error.payload
    : {
        success: false,
        code: error?.code || "INTERNAL_ERROR",
        message: error?.message || fallbackMessage
      };

  return res.status(resolvedStatus).json(payload);
}

const RUNNING_LIKE_STATUSES = new Set([
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
  "2fa_failed"
]);

function normalizeStatusValue(status) {
  return String(status || "").trim().toLowerCase();
}

function isRunningLikeStatus(status) {
  return RUNNING_LIKE_STATUSES.has(normalizeStatusValue(status));
}

function isStartAllEligibleAccount(account) {
  if (!account) return false;
  const status = normalizeStatusValue(account.status);
  if (!status) return true;
  if (isRunningLikeStatus(status)) return false;
  if (status === "banned" || status === "blocked") return false;
  return START_ALL_ELIGIBLE_STATUSES.has(status);
}

async function submitVerificationWithWorkerFallback(accountId, code, fallbackSubmit) {
  if (typeof workerManager.submitVerificationCode === "function") {
    try {
      const workerResult = await workerManager.submitVerificationCode(accountId, code);
      if (workerResult && typeof workerResult === "object") {
        return workerResult;
      }
    } catch (error) {
      const message = String(error?.message || "").toLowerCase();
      const noWorkerSession = message.includes("no active verification session");
      if (!noWorkerSession) {
        throw error;
      }
    }
  }

  return fallbackSubmit(accountId, code);
}

const createAccount = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;

    const clientIp = getClientIp(req);
    const accountLimit = getLimitFromRequest(req);
    const usedAccounts = await Account.countDocuments(getScopedFilter(req));

    if (Number.isFinite(accountLimit) && usedAccounts >= accountLimit) {
      return res.status(403).json({
        success: false,
        message: `Account limit reached (${accountLimit} max). Upgrade license.`,
        meta: {
          usedAccounts,
          accountLimit
        }
      });
    }

    const payload = normalizeAccountPayload(req.body);
    const validationError = validateAccountPayload(payload);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError
      });
    }

    const account = await Account.create({
      ...payload,
      userId: req.user._id,
      status: "starting"
    });

    setImmediate(() => {
      workerManager.requestStart(account, {
        ip: clientIp,
        userId: req.user?._id,
        resetRuntimeFields: true,
        emitPendingConnectionTest: true
      }).catch((error) => {
        console.error(`[START] Failed for ${account._id}:`, error.message);
      });
    });

    return res.status(201).json({
      success: true,
      data: account,
      meta: {
        usedAccounts: usedAccounts + 1,
        accountLimit
      }
    });
  } catch (error) {
    console.error("[POST /api/accounts] Error:", error.stack || error.message);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
exports.createAccount = createAccount;
exports.addAccount = createAccount;

exports.getAccounts = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;

    const accountLimit = await resolveUserAccountLimit(req);
    const accounts = await Account.find(getScopedFilter(req)).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: accounts.length,
      data: accounts,
      meta: {
        usedAccounts: accounts.length,
        accountLimit
      }
    });
  } catch (error) {
    console.error("[GET /api/accounts] Error:", error.stack || error.message);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.getAccountById = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;

    const account = await Account.findOne(
      getScopedFilter(req, { _id: req.params.id })
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }

    return res.status(200).json({
      success: true,
      data: account
    });
  } catch (error) {
    console.error("[GET /api/accounts/:id] Error:", error.stack || error.message);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.getCaptcha = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;
    const account = await findScopedAccount(req, req.params.id, "_id");
    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }
    const data = await getCaptchaForAccount(req.params.id);
    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      message: error.message
    });
  }
};

exports.submitCaptcha = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;
    const account = await findScopedAccount(req, req.params.id, "_id");
    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }
    const { captchaText } = req.body;

    if (!captchaText || !String(captchaText).trim()) {
      return res.status(400).json({
        success: false,
        message: "captchaText is required"
      });
    }

    const result = await submitCaptchaForAccount(req.params.id, captchaText);
    const httpStatus = result.success || result.retryable ? 200 : 400;
    return res.status(httpStatus).json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.refreshCaptcha = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;
    const account = await findScopedAccount(req, req.params.id, "_id");
    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }
    const captchaUrl = await refreshCaptchaForAccount(req.params.id);
    return res.status(200).json({
      success: true,
      data: { captchaUrl },
      message: "Captcha refreshed"
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

exports.getVerification = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;
    const account = await findScopedAccount(req, req.params.id, "_id");
    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }
    const data = await getVerificationForAccount(req.params.id);
    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      message: error.message
    });
  }
};

exports.submitVerification = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;
    const account = await findScopedAccount(req, req.params.id, "_id");
    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }
    const { code } = req.body;

    if (!/^\d{4}$/.test(String(code || "").trim())) {
      return res.status(400).json({
        success: false,
        message: "code must be exactly 4 digits"
      });
    }

    const result = await submitVerificationWithWorkerFallback(
      req.params.id,
      code,
      submitVerificationForAccount
    );
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return sendStructuredEngineError(res, error, "Failed to submit verification code");
  }
};

exports.getTwoFactor = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;
    const account = await findScopedAccount(req, req.params.id, "_id");
    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }
    const data = await getTwoFactorForAccount(req.params.id);
    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      message: error.message
    });
  }
};

exports.submitTwoFactor = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;
    const account = await findScopedAccount(req, req.params.id, "_id");
    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }
    const { code } = req.body;

    if (!/^\d{4}$/.test(String(code || "").trim())) {
      return res.status(400).json({
        success: false,
        message: "code must be exactly 4 digits"
      });
    }

    const result = await submitVerificationWithWorkerFallback(
      req.params.id,
      code,
      submitTwoFactorForAccount
    );
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return sendStructuredEngineError(res, error, "Failed to submit 2FA code");
  }
};

exports.updateAccount = async (req, res) => {
  try {
    const payload = normalizeAccountPayload(req.body, { isUpdate: true });
    const account = await Account.findOneAndUpdate(
      getScopedFilter(req, { _id: req.params.id }),
      payload,
      { new: true }
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }

    return res.status(200).json({
      success: true,
      data: account
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.deleteAccount = async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const account = await Account.findOne(
      getScopedFilter(req, { _id: req.params.id })
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }

    if (await workerManager.isRunning(account._id.toString(), { userId: req.user?._id })) {
      await workerManager.requestStop(account._id.toString(), {
        ip: clientIp,
        userId: req.user?._id
      });
    }

    await Account.deleteOne(getScopedFilter(req, { _id: req.params.id }));

    const deleteSuffix = Math.floor(Date.now() / 1000);

    await logActivity({
      level: "warning",
      message: `Deleted account: ${account.email}`,
      ip: clientIp,
      email: account.email,
      accountId: account._id,
      userId: req.user?._id
    });

    await logActivity({
      level: "info",
      message: "Account deleted",
      ip: clientIp,
      email: `${account.email}_${deleteSuffix}`,
      accountId: account._id,
      userId: req.user?._id,
      metadata: {
        reason: "user_delete"
      }
    });

    return res.status(200).json({
      success: true,
      message: "Account deleted"
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.startAccount = async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const account = await Account.findOne(
      getScopedFilter(req, { _id: req.params.id })
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }

    await workerManager.requestStart(account, {
      ip: clientIp,
      userId: req.user?._id,
      resetRuntimeFields: true,
      emitPendingConnectionTest: true
    });

    return res.status(200).json({
      success: true,
      message: "Account started"
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.stopAccount = async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const account = await Account.findOne(
      getScopedFilter(req, { _id: req.params.id })
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }

    await workerManager.requestStop(account._id.toString(), {
      ip: clientIp,
      userId: req.user?._id
    });

    await logActivity({
      level: "info",
      message: `Stopped account: ${account.email}`,
      ip: clientIp,
      email: account.email,
      accountId: account._id,
      userId: req.user?._id
    });

    return res.status(200).json({
      success: true,
      message: "Account stopped"
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.restartAccount = async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const account = await Account.findOne(
      getScopedFilter(req, { _id: req.params.id })
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }

    const result = await workerManager.restartAccount(account, {
      ip: clientIp,
      userId: req.user?._id,
      stopTimeoutMs: 5000,
      restartDelayMs: 3000
    });

    const latest = await Account.findOne(
      getScopedFilter(req, { _id: req.params.id })
    );

    await logActivity({
      level: "info",
      message: `Restarted account: ${account.email}`,
      ip: clientIp,
      email: account.email,
      accountId: account._id,
      userId: req.user?._id
    }).catch(() => null);

    return res.status(200).json({
      success: true,
      message: "Account restart requested",
      data: latest || result || { accountId: String(account._id), status: "starting" }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.startAllAccounts = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;

    const clientIp = getClientIp(req);
    const hasAccountIdsFilter = Array.isArray(req.body?.accountIds);
    const requestedIds = hasAccountIdsFilter
      ? req.body.accountIds
          .map((value) => String(value || "").trim())
          .filter((value) => value && mongoose.Types.ObjectId.isValid(value))
      : [];

    if (hasAccountIdsFilter && requestedIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid accountIds provided"
      });
    }

    const query = getScopedFilter(
      req,
      requestedIds.length > 0 ? { _id: { $in: requestedIds } } : {}
    );

    const accounts = await Account.find(query).select("_id email status workerState");
    const eligible = [];
    const skipped = [];
    const workerStatusSnapshot =
      typeof workerManager.getWorkerStatus === "function"
        ? await workerManager.getWorkerStatus({ userId: req.user?._id })
        : null;
    const runningWorkerIds = new Set(
      Array.isArray(workerStatusSnapshot?.runningAccounts)
        ? workerStatusSnapshot.runningAccounts.map((value) => String(value))
        : []
    );

    for (const account of accounts) {
      const accountId = String(account._id);
      const runningInWorker = runningWorkerIds.has(accountId);
      const statusValue = normalizeStatusValue(account.status);

      if (account?.workerState?.blockedReason) {
        skipped.push({
          accountId,
          email: account.email,
          reason: "blocked_reason"
        });
        continue;
      }

      const runningLikeWithoutWorker =
        isRunningLikeStatus(statusValue) && !runningInWorker;

      if (!isStartAllEligibleAccount(account) && !runningLikeWithoutWorker) {
        skipped.push({
          accountId,
          email: account.email,
          reason: `status_${statusValue || "unknown"}`
        });
        continue;
      }

      eligible.push(account);
    }

    const settled = await Promise.allSettled(
      eligible.map((account) =>
        workerManager.requestStart(account, {
          ip: clientIp,
          userId: req.user?._id,
          resetRuntimeFields: true,
          emitPendingConnectionTest: true
        })
      )
    );

    const startedAccountIds = [];
    const failed = [];

    settled.forEach((result, index) => {
      const account = eligible[index];
      const accountId = String(account._id);

      if (result.status === "fulfilled") {
        startedAccountIds.push(accountId);
        return;
      }

      failed.push({
        accountId,
        email: account.email,
        message: result.reason?.message || "Failed to start account"
      });
    });

    await logActivity({
      level: failed.length > 0 ? "warning" : "info",
      message: `Bulk start requested: ${startedAccountIds.length}/${eligible.length} eligible`,
      ip: clientIp,
      userId: req.user?._id,
      metadata: {
        requested: accounts.length,
        eligible: eligible.length,
        started: startedAccountIds.length,
        skipped: skipped.length,
        failed: failed.length
      }
    }).catch(() => null);

    return res.status(200).json({
      success: failed.length === 0,
      message:
        failed.length === 0
          ? `Queued ${startedAccountIds.length} account(s) to start`
          : `Queued ${startedAccountIds.length} account(s); ${failed.length} failed`,
      data: {
        requested: accounts.length,
        eligible: eligible.length,
        started: startedAccountIds.length,
        skipped,
        failed,
        startedAccountIds
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.stopAllAccounts = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;

    const clientIp = getClientIp(req);
    const hasAccountIdsFilter = Array.isArray(req.body?.accountIds);
    const requestedIds = hasAccountIdsFilter
      ? req.body.accountIds
          .map((value) => String(value || "").trim())
          .filter((value) => value && mongoose.Types.ObjectId.isValid(value))
      : [];

    if (hasAccountIdsFilter && requestedIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid accountIds provided"
      });
    }

    const query = getScopedFilter(
      req,
      requestedIds.length > 0 ? { _id: { $in: requestedIds } } : {}
    );

    const accounts = await Account.find(query).select("_id email status");
    const accountById = new Map(accounts.map((account) => [String(account._id), account]));
    const workerStatus =
      typeof workerManager.getWorkerStatus === "function"
        ? await workerManager.getWorkerStatus({ userId: req.user?._id })
        : null;
    const runningWorkerIds = Array.isArray(workerStatus?.runningAccounts)
      ? workerStatus.runningAccounts.map((value) => String(value))
      : [];

    const stopTargetIds = new Set();

    for (const account of accounts) {
      if (isRunningLikeStatus(account.status)) {
        stopTargetIds.add(String(account._id));
      }
    }

    for (const runningId of runningWorkerIds) {
      if (requestedIds.length === 0 || accountById.has(runningId)) {
        stopTargetIds.add(runningId);
      }
    }

    const targetIds = Array.from(stopTargetIds);
    const settled = await Promise.allSettled(
      targetIds.map((accountId) =>
        workerManager.requestStop(accountId, {
          ip: clientIp,
          userId: req.user?._id
        })
      )
    );

    const stoppedAccountIds = [];
    const failed = [];

    settled.forEach((result, index) => {
      const accountId = targetIds[index];
      const account = accountById.get(accountId);

      if (result.status === "fulfilled") {
        stoppedAccountIds.push(accountId);
        return;
      }

      failed.push({
        accountId,
        email: account?.email || "",
        message: result.reason?.message || "Failed to stop account"
      });
    });

    await logActivity({
      level: failed.length > 0 ? "warning" : "info",
      message: `Bulk stop requested: ${stoppedAccountIds.length}/${stopTargetIds.size} targeted`,
      ip: clientIp,
      userId: req.user?._id,
      metadata: {
        requested: accounts.length,
        targeted: stopTargetIds.size,
        stopped: stoppedAccountIds.length,
        failed: failed.length
      }
    }).catch(() => null);

    return res.status(200).json({
      success: failed.length === 0,
      message:
        failed.length === 0
          ? `Stopped ${stoppedAccountIds.length} account(s)`
          : `Stopped ${stoppedAccountIds.length} account(s); ${failed.length} failed`,
      data: {
        requested: accounts.length,
        targeted: stopTargetIds.size,
        stopped: stoppedAccountIds.length,
        failed,
        stoppedAccountIds
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.testAccount = async (req, res) => {
  try {
    const account = await Account.findOne(
      getScopedFilter(req, { _id: req.params.id })
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }

    await runAccount(account);

    return res.status(200).json({
      success: true,
      message: "Proxy and User Agent test completed. Check server logs for details."
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.testConnection = async (req, res) => {
  try {
    const account = await Account.findOne(
      getScopedFilter(req, { _id: req.params.id })
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }

    const testResult = await testProxyNavigation(account);

    account.connectionTest = {
      ...testResult,
      testedAt: new Date()
    };

    await account.save();

    const io = global.io;
    if (io) {
      await emitAccountUpdate(io, account, {
        connectionTest: account.connectionTest
      });
    }

    return res.status(200).json({
      success: testResult.success,
      data: testResult
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.getAccountStatus = async (req, res) => {
  try {
    const account = await Account.findOne(
      getScopedFilter(req, { _id: req.params.id })
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }

    const isRunning = await workerManager.isRunning(account._id.toString(), {
      userId: req.user?._id
    });

    return res.status(200).json({
      success: true,
      data: {
        accountId: account._id,
        email: account.email,
        isRunning,
        status: isRunning ? "active" : "stopped"
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.resetRetry = async (req, res) => {
  try {
    if (!ensureDbConnected(res)) return;

    const account = await Account.findOne(
      getScopedFilter(req, { _id: req.params.id })
    );
    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }

    const updated = await workerManager.resetRetry(req.params.id, {
      userId: req.user?._id
    });
    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Account not found"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Retry state reset",
      data: {
        accountId: updated._id,
        workerState: updated.workerState,
        status: updated.status
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.getWorkersStatus = async (req, res) => {
  try {
    return res.status(200).json(
      await workerManager.getWorkerStatus({
        userId: req.user?._id
      })
    );
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
