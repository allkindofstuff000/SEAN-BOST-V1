const bcrypt = require("bcryptjs");
const User = require("../model/User");
const {
  AUTH_COOKIE_NAME,
  signAuthToken,
  getAuthCookieOptions
} = require("../utils/authToken");

const SALT_ROUNDS = 10;

function sanitizeUser(user) {
  if (!user) return null;
  return {
    _id: user._id,
    username: user.username,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    licenseId: user.licenseId || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

async function ensureBootstrapAdmin() {
  const adminEmail = String(process.env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || "").trim();
  const adminUsername = String(process.env.ADMIN_USERNAME || "admin")
    .trim()
    .toLowerCase();

  if (!adminEmail || !adminPassword) {
    return;
  }

  const existingAdmin = await User.findOne({ role: "admin" }).select("_id").lean();
  if (existingAdmin) {
    return;
  }

  const hasConflict = await User.findOne({
    $or: [{ email: adminEmail }, { username: adminUsername }]
  })
    .select("_id")
    .lean();

  if (hasConflict) {
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, SALT_ROUNDS);
  await User.create({
    username: adminUsername,
    email: adminEmail,
    passwordHash,
    role: "admin",
    isActive: true
  });
}

exports.login = async (req, res) => {
  try {
    await ensureBootstrapAdmin();

    const identifier = String(
      req.body?.identifier || req.body?.email || req.body?.username || ""
    ).trim();
    const password = String(req.body?.password || "");

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message: "identifier and password are required"
      });
    }

    const normalizedIdentifier = identifier.toLowerCase();
    const user = await User.findOne({
      $or: [{ email: normalizedIdentifier }, { username: identifier }]
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "User is disabled"
      });
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    const token = signAuthToken({
      sub: String(user._id),
      role: user.role
    });

    res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());

    return res.status(200).json({
      success: true,
      data: sanitizeUser(user)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Login failed"
    });
  }
};

exports.logout = async (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, {
    ...getAuthCookieOptions(),
    maxAge: undefined
  });

  return res.status(200).json({
    success: true,
    message: "Logged out"
  });
};

exports.me = async (req, res) => {
  if (!req.user?._id) {
    return res.status(401).json({
      success: false,
      message: "Authentication required"
    });
  }

  const user = await User.findById(req.user._id).lean();
  if (!user || user.isActive === false) {
    return res.status(401).json({
      success: false,
      message: "Authentication required"
    });
  }

  return res.status(200).json({
    success: true,
    data: sanitizeUser(user)
  });
};

exports.sanitizeUser = sanitizeUser;
