const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const License = require("../model/License");
const User = require("../model/User");
const { sanitizeUser } = require("./authController");
const { generateLicenseKey, maskLicenseKey } = require("../utils/licenseKey");

const SALT_ROUNDS = 10;
const LICENSE_KEY_RETRY_LIMIT = 5;

function parsePositiveInt(value, fallback, min = 1, max = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim().toLowerCase());
}

function normalizeStatus(license) {
  const now = Date.now();
  const expiresAt = new Date(license?.expiresAt).valueOf();
  if (String(license?.status || "").toLowerCase() === "revoked") {
    return "revoked";
  }
  if (Number.isNaN(expiresAt) || now > expiresAt) {
    return "expired";
  }
  return "active";
}

function normalizeLicenseForResponse(license, { mask = false } = {}) {
  if (!license) return null;
  const plain = license?.toObject ? license.toObject() : license;

  return {
    _id: plain._id,
    key: mask ? maskLicenseKey(plain.key) : plain.key,
    keyMasked: maskLicenseKey(plain.key),
    maxAccounts: plain.maxAccounts,
    expiresAt: plain.expiresAt,
    status: normalizeStatus(plain),
    rawStatus: plain.status,
    notes: plain.notes || "",
    createdBy: plain.createdBy || null,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt
  };
}

function normalizeUserForResponse(user) {
  const safe = sanitizeUser(user);
  const license = user?.licenseId;
  if (!license) {
    return {
      ...safe,
      license: null
    };
  }

  const rawLicense = license?.toObject ? license.toObject() : license;
  return {
    ...safe,
    license: {
      _id: rawLicense._id,
      key: rawLicense.key,
      keyMasked: maskLicenseKey(rawLicense.key),
      maxAccounts: rawLicense.maxAccounts,
      expiresAt: rawLicense.expiresAt,
      status: normalizeStatus(rawLicense),
      rawStatus: rawLicense.status
    }
  };
}

function parseDateOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed;
}

async function createUniqueLicenseKey(prefix = "SB") {
  for (let attempt = 0; attempt < LICENSE_KEY_RETRY_LIMIT; attempt += 1) {
    const candidate = generateLicenseKey(prefix);
    // eslint-disable-next-line no-await-in-loop
    const exists = await License.exists({ key: candidate });
    if (!exists) {
      return candidate;
    }
  }

  throw new Error("Could not generate unique license key");
}

exports.getAdminOverview = async (_req, res) => {
  try {
    const now = new Date();
    const inSevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [totalUsers, totalLicenses, activeLicenses, expiringSoon] = await Promise.all([
      User.countDocuments({}),
      License.countDocuments({}),
      License.countDocuments({
        status: "active",
        expiresAt: { $gte: now }
      }),
      License.countDocuments({
        status: "active",
        expiresAt: {
          $gte: now,
          $lte: inSevenDays
        }
      })
    ]);

    return res.status(200).json({
      success: true,
      data: {
        totalUsers,
        totalLicenses,
        activeLicenses,
        expiringSoon
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.createLicense = async (req, res) => {
  try {
    const maxAccounts = Number(req.body?.maxAccounts);
    const expiresAt = parseDateOrNull(req.body?.expiresAt);
    const notes = String(req.body?.notes || "").trim();

    if (!Number.isFinite(maxAccounts) || maxAccounts < 1) {
      return res.status(400).json({
        success: false,
        message: "maxAccounts must be at least 1"
      });
    }

    if (!expiresAt) {
      return res.status(400).json({
        success: false,
        message: "Valid expiresAt is required"
      });
    }

    const key = await createUniqueLicenseKey("SB");
    const created = await License.create({
      key,
      maxAccounts: Math.floor(maxAccounts),
      expiresAt,
      notes,
      status: "active",
      createdBy: req.user?._id || null
    });

    return res.status(201).json({
      success: true,
      data: normalizeLicenseForResponse(created)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.listLicenses = async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 1, 5000);
    const limit = parsePositiveInt(req.query.limit, 20, 1, 100);
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim().toLowerCase();
    const skip = (page - 1) * limit;

    const now = new Date();
    const filter = {};

    if (q) {
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ key: regex }, { notes: regex }];
    }

    if (status === "revoked") {
      filter.status = "revoked";
    } else if (status === "active") {
      filter.status = "active";
      filter.expiresAt = { $gte: now };
    } else if (status === "expired") {
      filter.status = "active";
      filter.expiresAt = { $lt: now };
    }

    const [total, items] = await Promise.all([
      License.countDocuments(filter),
      License.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    return res.status(200).json({
      success: true,
      data: items.map((item) => normalizeLicenseForResponse(item)),
      page,
      limit,
      total,
      pages: total === 0 ? 0 : Math.ceil(total / limit)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.updateLicense = async (req, res) => {
  try {
    const licenseId = String(req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(licenseId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid license id"
      });
    }

    const patch = {};

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "maxAccounts")) {
      const maxAccounts = Number(req.body.maxAccounts);
      if (!Number.isFinite(maxAccounts) || maxAccounts < 1) {
        return res.status(400).json({
          success: false,
          message: "maxAccounts must be at least 1"
        });
      }
      patch.maxAccounts = Math.floor(maxAccounts);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "expiresAt")) {
      const expiresAt = parseDateOrNull(req.body.expiresAt);
      if (!expiresAt) {
        return res.status(400).json({
          success: false,
          message: "Invalid expiresAt"
        });
      }
      patch.expiresAt = expiresAt;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "status")) {
      const status = String(req.body.status || "").trim().toLowerCase();
      if (!["active", "revoked"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "status must be active or revoked"
        });
      }
      patch.status = status;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "notes")) {
      patch.notes = String(req.body.notes || "").trim();
    }

    const updated = await License.findByIdAndUpdate(licenseId, { $set: patch }, { new: true });
    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "License not found"
      });
    }

    return res.status(200).json({
      success: true,
      data: normalizeLicenseForResponse(updated)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.createUser = async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const role = String(req.body?.role || "user").trim().toLowerCase() || "user";
    const licenseId = req.body?.licenseId ? String(req.body.licenseId).trim() : null;

    if (!username || username.length < 3) {
      return res.status(400).json({
        success: false,
        message: "username must be at least 3 characters"
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Valid email is required"
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "password must be at least 6 characters"
      });
    }

    if (!["admin", "user"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "role must be admin or user"
      });
    }

    let resolvedLicenseId = null;
    if (licenseId) {
      if (!mongoose.Types.ObjectId.isValid(licenseId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid licenseId"
        });
      }

      const licenseExists = await License.exists({ _id: licenseId });
      if (!licenseExists) {
        return res.status(404).json({
          success: false,
          message: "License not found"
        });
      }

      resolvedLicenseId = licenseId;
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const created = await User.create({
      username,
      email,
      passwordHash,
      role,
      licenseId: resolvedLicenseId,
      isActive: true
    });

    const hydrated = await User.findById(created._id).populate("licenseId").lean();
    return res.status(201).json({
      success: true,
      data: normalizeUserForResponse(hydrated)
    });
  } catch (error) {
    if (error?.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || "field";
      return res.status(409).json({
        success: false,
        message: `${field} already exists`
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.listUsers = async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 1, 5000);
    const limit = parsePositiveInt(req.query.limit, 20, 1, 100);
    const q = String(req.query.q || "").trim();
    const skip = (page - 1) * limit;

    const filter = {};
    if (q) {
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ username: regex }, { email: regex }];
    }

    const [total, items] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select("-passwordHash")
        .populate("licenseId")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    return res.status(200).json({
      success: true,
      data: items.map((item) => normalizeUserForResponse(item)),
      page,
      limit,
      total,
      pages: total === 0 ? 0 : Math.ceil(total / limit)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const userId = String(req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id"
      });
    }

    const patch = {};

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "isActive")) {
      patch.isActive = Boolean(req.body.isActive);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "licenseId")) {
      const licenseId = req.body.licenseId;

      if (licenseId === null || licenseId === "") {
        patch.licenseId = null;
      } else {
        const normalized = String(licenseId || "").trim();
        if (!mongoose.Types.ObjectId.isValid(normalized)) {
          return res.status(400).json({
            success: false,
            message: "Invalid licenseId"
          });
        }

        const licenseExists = await License.exists({ _id: normalized });
        if (!licenseExists) {
          return res.status(404).json({
            success: false,
            message: "License not found"
          });
        }

        patch.licenseId = normalized;
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "password")) {
      const password = String(req.body.password || "");
      if (password.length < 6) {
        return res.status(400).json({
          success: false,
          message: "password must be at least 6 characters"
        });
      }
      patch.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "role")) {
      const role = String(req.body.role || "").trim().toLowerCase();
      if (!["admin", "user"].includes(role)) {
        return res.status(400).json({
          success: false,
          message: "role must be admin or user"
        });
      }
      patch.role = role;
    }

    const updated = await User.findByIdAndUpdate(userId, { $set: patch }, { new: true })
      .select("-passwordHash")
      .populate("licenseId")
      .lean();

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    return res.status(200).json({
      success: true,
      data: normalizeUserForResponse(updated)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
