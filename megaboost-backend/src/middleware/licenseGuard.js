const Account = require("../model/Account");
const mongoose = require("mongoose");

function getAccountLimit() {
  const limit = Number(process.env.LICENSE_LIMIT || process.env.ACCOUNT_LIMIT || 15);
  return Number.isNaN(limit) || limit < 1 ? 15 : limit;
}

function isLicenseActive() {
  const status = String(process.env.LICENSE_STATUS || "active").toLowerCase();
  if (status === "inactive" || status === "expired") {
    return false;
  }

  const expiresAt = process.env.LICENSE_EXPIRES_AT;
  if (expiresAt) {
    const expiry = new Date(expiresAt);
    if (!Number.isNaN(expiry.valueOf()) && Date.now() > expiry.valueOf()) {
      return false;
    }
  }

  return true;
}

async function requireActiveLicense(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        success: false,
        message: "Database not connected"
      });
    }

    if (!isLicenseActive()) {
      return res.status(403).json({
        success: false,
        message: "License inactive or expired"
      });
    }

    return next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

async function enforceAccountLimit(req, res, next) {
  try {
    const used = await Account.countDocuments();
    const limit = getAccountLimit();

    if (used >= limit) {
      return res.status(403).json({
        success: false,
        message: `Account limit reached (${used}/${limit})`,
        meta: {
          usedAccounts: used,
          accountLimit: limit
        }
      });
    }

    return next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

module.exports = {
  requireActiveLicense,
  enforceAccountLimit
};
