const User = require("../model/User");

function isExpired(expiresAt) {
  const value = new Date(expiresAt).valueOf();
  if (Number.isNaN(value)) return true;
  return Date.now() > value;
}

async function requireValidLicense(req, res, next) {
  try {
    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    if (String(req.user.role || "").toLowerCase() === "admin") {
      req.license = {
        status: "active",
        maxAccounts: Number.MAX_SAFE_INTEGER,
        expiresAt: null
      };
      return next();
    }

    const user = await User.findById(req.user._id)
      .populate("licenseId")
      .select("_id role isActive licenseId")
      .lean();

    if (!user || user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "User is disabled"
      });
    }

    const license = user.licenseId;
    if (!license) {
      return res.status(403).json({
        success: false,
        message: "No license assigned"
      });
    }

    if (String(license.status || "").toLowerCase() !== "active") {
      return res.status(403).json({
        success: false,
        message: "License revoked"
      });
    }

    if (isExpired(license.expiresAt)) {
      return res.status(403).json({
        success: false,
        message: "License expired"
      });
    }

    req.license = license;
    return next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "License check failed"
    });
  }
}

module.exports = {
  requireValidLicense
};
