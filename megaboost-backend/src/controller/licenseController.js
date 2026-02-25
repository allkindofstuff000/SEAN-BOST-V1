const Account = require("../model/Account");
const User = require("../model/User");
const { maskLicenseKey } = require("../utils/licenseKey");

function resolveLicenseStatus(license) {
  if (!license) return "no_license";
  if (String(license.status || "").toLowerCase() !== "active") return "revoked";

  const expiresAtTs = new Date(license.expiresAt).valueOf();
  if (Number.isNaN(expiresAtTs) || Date.now() > expiresAtTs) {
    return "expired";
  }

  return "active";
}

async function buildLicensePayload(req) {
  const role = String(req.user?.role || "").toLowerCase();
  const usedAccounts = await Account.countDocuments({ userId: req.user?._id });
  if (role === "admin") {
    return {
      status: "active",
      active: true,
      expiresAt: null,
      maxAccounts: Number.MAX_SAFE_INTEGER,
      usedAccounts,
      key: null
    };
  }

  const user = await User.findById(req.user?._id).populate("licenseId").lean();
  const license = user?.licenseId || null;
  const status = resolveLicenseStatus(license);

  return {
    status,
    active: status === "active",
    expiresAt: license?.expiresAt || null,
    maxAccounts: Number(license?.maxAccounts || 0),
    usedAccounts,
    key: license?.key ? maskLicenseKey(license.key) : null
  };
}

exports.getMyLicense = async (req, res) => {
  try {
    const payload = await buildLicensePayload(req);
    return res.status(200).json({
      success: true,
      data: payload
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.getLicenseLimits = exports.getMyLicense;
