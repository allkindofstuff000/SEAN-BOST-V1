const Account = require("../model/Account");
const { logActivity } = require("../utils/activityLogger");

function statusToLevel(status) {
  const value = String(status || "").trim().toLowerCase();

  if (["error", "crashed", "banned", "verification_failed", "verification_timeout"].includes(value)) {
    return "error";
  }

  if (["waiting_cooldown", "paused"].includes(value)) {
    return "warning";
  }

  if (["active", "running", "bumping", "completed"].includes(value)) {
    return "success";
  }

  return "info";
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  return metadata;
}

async function updateStatus(accountId, newStatus, options = {}) {
  const nextStatus = String(newStatus || "").trim();
  if (!nextStatus) {
    return;
  }

  try {
    const previous = await Account.findByIdAndUpdate(
      accountId,
      {
        status: nextStatus
      },
      {
        new: false
      }
    ).select("email status");

    if (!previous) {
      return;
    }

    console.log(`[STATUS] Updated -> ${nextStatus}`);

    const previousStatus = String(previous.status || "").trim();
    if (previousStatus === nextStatus) {
      return;
    }

    const extraMetadata = normalizeMetadata(options.metadata) || {};
    await logActivity({
      level: statusToLevel(nextStatus),
      message: `Status changed: ${previousStatus || "unknown"} -> ${nextStatus}`,
      ip: options.ip,
      email: options.email || previous.email,
      accountId,
      metadata: {
        telegram: false,
        previousStatus: previousStatus || null,
        newStatus: nextStatus,
        ...extraMetadata
      }
    });
  } catch (error) {
    console.error("Status update failed:", error.message);
  }
}

module.exports = { updateStatus };
