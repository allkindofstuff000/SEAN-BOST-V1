const mongoose = require("mongoose");
const Account = require("../../model/Account");
const TelegramGroupBinding = require("../../model/TelegramGroupBinding");

const DEFAULT_ACCOUNT_PROJECTION =
  "_id email status userId workerState proxyHost proxyPort connectionTest nextBumpAt waitingUntil totalBumpsToday lastBumpAt";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeAccountId(value) {
  return normalizeString(value);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createResolverError(message, code = "telegram_account_error", status = 400) {
  const error = new Error(String(message || "Telegram account resolution failed"));
  error.code = code;
  error.status = status;
  return error;
}

function getBindingFilter({ userId, chatId }) {
  const normalizedUserId = normalizeString(userId);
  const normalizedChatId = normalizeString(chatId);
  if (!normalizedUserId || !normalizedChatId) {
    return null;
  }

  return {
    userId: normalizedUserId,
    chatId: normalizedChatId
  };
}

function getAccountAliasDisplay(account, options = {}) {
  const email = normalizeString(account?.email);
  const accountId = normalizeAccountId(account?._id);
  if (options.preferAccountId && accountId) {
    return accountId;
  }
  return email || accountId || "this account";
}

function matchAccountTarget(account, rawTarget) {
  const target = normalizeString(rawTarget);
  if (!account || !target) {
    return false;
  }

  const targetAccountId = normalizeAccountId(target);
  const targetEmail = normalizeEmail(target);

  const accountId = normalizeAccountId(account?._id);
  const email = normalizeEmail(account?.email);

  return Boolean(
    (targetAccountId && accountId === targetAccountId) ||
      (targetEmail && email === targetEmail)
  );
}

async function getTelegramGroupBinding({ userId, chatId }) {
  const filter = getBindingFilter({ userId, chatId });
  if (!filter) {
    return null;
  }

  return TelegramGroupBinding.findOne(filter).lean();
}

async function removeTelegramGroupBinding({ userId, chatId }) {
  const filter = getBindingFilter({ userId, chatId });
  if (!filter) {
    return { deletedCount: 0 };
  }

  return TelegramGroupBinding.deleteOne(filter);
}

async function loadBoundAccount(binding, userId, projection = DEFAULT_ACCOUNT_PROJECTION) {
  if (!binding?.accountId || !userId) {
    return null;
  }

  const account = await Account.findOne({
    _id: binding.accountId,
    userId
  })
    .select(projection)
    .lean();

  if (account) {
    return account;
  }

  await TelegramGroupBinding.deleteOne({ _id: binding._id }).catch(() => null);
  throw createResolverError(
    "Bound account no longer exists. Use /bind_account <target> again.",
    "binding_account_missing",
    404
  );
}

async function findAccountByTarget(userId, rawTarget, projection = DEFAULT_ACCOUNT_PROJECTION) {
  const target = normalizeString(rawTarget);
  if (!target || !userId) {
    return null;
  }

  if (mongoose.Types.ObjectId.isValid(target)) {
    const byId = await Account.findOne({
      _id: target,
      userId
    })
      .select(projection)
      .lean();
    if (byId) {
      return byId;
    }
  }

  const email = normalizeEmail(target);
  if (email) {
    const byEmail = await Account.findOne({
      userId,
      email: new RegExp(`^${escapeRegExp(email)}$`, "i")
    })
      .select(projection)
      .lean();
    if (byEmail) {
      return byEmail;
    }
  }

  return null;
}

async function resolveAccountTarget({
  userId,
  rawTarget,
  chatId,
  strictBinding = true,
  projection = DEFAULT_ACCOUNT_PROJECTION
} = {}) {
  const normalizedUserId = normalizeString(userId);
  if (!normalizedUserId) {
    throw createResolverError("userId is required", "missing_user_id", 400);
  }

  const binding = await getTelegramGroupBinding({
    userId: normalizedUserId,
    chatId
  });
  const boundAccount = binding
    ? await loadBoundAccount(binding, normalizedUserId, projection)
    : null;
  const target = normalizeString(rawTarget);

  if (!target) {
    if (boundAccount) {
      return {
        account: boundAccount,
        binding,
        matchedBy: "binding",
        usedBinding: true
      };
    }

    throw createResolverError(
      "Target account required. Use /status email@example.com, /status ACCOUNT_ID, or bind this group first.",
      "missing_target",
      400
    );
  }

  if (boundAccount && strictBinding && !matchAccountTarget(boundAccount, target)) {
    throw createResolverError(
      `This group is bound to ${getAccountAliasDisplay(boundAccount, { fallbackToEmail: true })} only.`,
      "binding_mismatch",
      403
    );
  }

  if (boundAccount && matchAccountTarget(boundAccount, target)) {
    return {
      account: boundAccount,
      binding,
      matchedBy: "binding_target",
      usedBinding: true
    };
  }

  const account = await findAccountByTarget(normalizedUserId, target, projection);
  if (!account) {
    throw createResolverError(
      "Account not found. Use exact email or account ID.",
      "account_not_found",
      404
    );
  }

  return {
    account,
    binding,
    matchedBy: "direct_target",
    usedBinding: false
  };
}

async function bindTelegramGroupToAccount({ userId, chatId, accountId }) {
  const filter = getBindingFilter({ userId, chatId });
  if (!filter) {
    throw createResolverError("chatId is required to bind a Telegram group", "missing_chat_id", 400);
  }

  if (!normalizeAccountId(accountId)) {
    throw createResolverError("accountId is required to bind a Telegram group", "missing_account_id", 400);
  }

  return TelegramGroupBinding.findOneAndUpdate(
    filter,
    {
      $set: {
        accountId
      }
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    }
  ).lean();
}

module.exports = {
  DEFAULT_ACCOUNT_PROJECTION,
  getAccountAliasDisplay,
  matchAccountTarget,
  getTelegramGroupBinding,
  removeTelegramGroupBinding,
  resolveAccountTarget,
  bindTelegramGroupToAccount
};
