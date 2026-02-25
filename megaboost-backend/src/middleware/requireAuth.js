const User = require("../model/User");
const { AUTH_COOKIE_NAME, verifyAuthToken } = require("../utils/authToken");

function getBearerToken(req) {
  const header = String(req.headers?.authorization || "");
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

async function requireAuth(req, res, next) {
  const token =
    String(req.cookies?.[AUTH_COOKIE_NAME] || "").trim() || getBearerToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required"
    });
  }

  try {
    const payload = verifyAuthToken(token);
    const userId = String(payload?.sub || "").trim();
    if (!userId) {
      throw new Error("Invalid auth payload");
    }

    const user = await User.findById(userId)
      .select("_id username email role isActive licenseId")
      .lean();

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "User is disabled"
      });
    }

    req.user = user;
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired session"
    });
  }
}

module.exports = {
  requireAuth
};
