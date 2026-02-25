#!/usr/bin/env node
require("dotenv").config();

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const User = require("../src/model/User");
const License = require("../src/model/License");
const { generateLicenseKey } = require("../src/utils/licenseKey");

const SALT_ROUNDS = 10;
const LICENSE_KEY_RETRY_LIMIT = 5;
const DEFAULT_SEED_MARKER = "seed:starter-license";

function envString(name, fallback = "") {
  const value = process.env[name];
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function envInt(name, fallback) {
  const parsed = Number.parseInt(envString(name, String(fallback)), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function envBool(name, fallback = false) {
  const value = envString(name, "");
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

async function createUniqueLicenseKey(prefix = "SB") {
  for (let attempt = 0; attempt < LICENSE_KEY_RETRY_LIMIT; attempt += 1) {
    const candidate = generateLicenseKey(prefix);
    // eslint-disable-next-line no-await-in-loop
    const exists = await License.exists({ key: candidate });
    if (!exists) return candidate;
  }

  throw new Error("Failed to generate a unique license key after multiple retries");
}

async function ensureAdmin({
  username,
  email,
  password,
  resetPassword
}) {
  const existing = await User.findOne({
    $or: [{ email: email.toLowerCase() }, { username }]
  });

  if (!existing) {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const created = await User.create({
      username,
      email: email.toLowerCase(),
      passwordHash,
      role: "admin",
      isActive: true
    });
    console.log(`[seed] Created admin user: ${created.username} (${created.email})`);
    return created;
  }

  const patch = {};
  if (existing.role !== "admin") {
    patch.role = "admin";
  }
  if (existing.isActive === false) {
    patch.isActive = true;
  }

  if (resetPassword) {
    const samePassword = await bcrypt.compare(password, existing.passwordHash);
    if (!samePassword) {
      patch.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    }
  }

  if (Object.keys(patch).length > 0) {
    const updated = await User.findByIdAndUpdate(existing._id, { $set: patch }, { new: true });
    console.log(`[seed] Updated existing admin user: ${updated.username} (${updated.email})`);
    return updated;
  }

  console.log(`[seed] Admin user already exists: ${existing.username} (${existing.email})`);
  return existing;
}

async function ensureStarterLicense({
  seedMarker,
  maxAccounts,
  expiresAt,
  createdBy
}) {
  let license = await License.findOne({ notes: seedMarker });

  if (!license) {
    const key = await createUniqueLicenseKey("SB");
    license = await License.create({
      key,
      maxAccounts,
      expiresAt,
      status: "active",
      notes: seedMarker,
      createdBy: createdBy || null
    });
    console.log(`[seed] Created starter license: ${license.key}`);
    return license;
  }

  const patch = {};
  if (license.maxAccounts !== maxAccounts) patch.maxAccounts = maxAccounts;
  if (new Date(license.expiresAt).valueOf() !== expiresAt.valueOf()) {
    patch.expiresAt = expiresAt;
  }
  if (license.status !== "active") patch.status = "active";
  if (!license.createdBy && createdBy) patch.createdBy = createdBy;

  if (Object.keys(patch).length > 0) {
    license = await License.findByIdAndUpdate(license._id, { $set: patch }, { new: true });
    console.log(`[seed] Updated starter license: ${license.key}`);
  } else {
    console.log(`[seed] Starter license already exists: ${license.key}`);
  }

  return license;
}

async function ensureStarterUser({
  username,
  email,
  password,
  licenseId,
  resetPassword
}) {
  const existing = await User.findOne({
    $or: [{ email: email.toLowerCase() }, { username }]
  });

  if (!existing) {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const created = await User.create({
      username,
      email: email.toLowerCase(),
      passwordHash,
      role: "user",
      isActive: true,
      licenseId
    });
    console.log(`[seed] Created starter user: ${created.username} (${created.email})`);
    return created;
  }

  if (existing.role === "admin") {
    throw new Error(
      `Starter user collision: ${existing.email} is already an admin account.`
    );
  }

  const patch = {};
  if (existing.role !== "user") patch.role = "user";
  if (existing.isActive === false) patch.isActive = true;
  if (!existing.licenseId || String(existing.licenseId) !== String(licenseId)) {
    patch.licenseId = licenseId;
  }

  if (resetPassword) {
    const samePassword = await bcrypt.compare(password, existing.passwordHash);
    if (!samePassword) {
      patch.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    }
  }

  if (Object.keys(patch).length > 0) {
    const updated = await User.findByIdAndUpdate(existing._id, { $set: patch }, { new: true });
    console.log(`[seed] Updated starter user: ${updated.username} (${updated.email})`);
    return updated;
  }

  console.log(`[seed] Starter user already exists: ${existing.username} (${existing.email})`);
  return existing;
}

async function main() {
  const adminUsername = envString("SEED_ADMIN_USERNAME", "admin");
  const adminEmail = envString("SEED_ADMIN_EMAIL", envString("ADMIN_EMAIL", "admin@megaboost.local"));
  const adminPassword = envString("SEED_ADMIN_PASSWORD", envString("ADMIN_PASSWORD", "Admin123!"));

  const starterUsername = envString("SEED_STARTER_USERNAME", "starter_user");
  const starterEmail = envString("SEED_STARTER_EMAIL", "starter@megaboost.local");
  const starterPassword = envString("SEED_STARTER_PASSWORD", "Starter123!");

  const starterMaxAccounts = Math.max(1, envInt("SEED_STARTER_MAX_ACCOUNTS", 5));
  const starterExpiresDays = Math.max(1, envInt("SEED_STARTER_EXPIRES_DAYS", 30));
  const seedMarker = envString("SEED_STARTER_LICENSE_MARKER", DEFAULT_SEED_MARKER);

  const resetPasswords = envBool("SEED_RESET_PASSWORDS", false);
  const expiresAt = new Date(Date.now() + starterExpiresDays * 24 * 60 * 60 * 1000);

  if (!adminPassword || adminPassword.length < 6) {
    throw new Error("SEED_ADMIN_PASSWORD must be at least 6 characters");
  }
  if (!starterPassword || starterPassword.length < 6) {
    throw new Error("SEED_STARTER_PASSWORD must be at least 6 characters");
  }

  await connectDB();

  const admin = await ensureAdmin({
    username: adminUsername,
    email: adminEmail,
    password: adminPassword,
    resetPassword: resetPasswords
  });

  const starterLicense = await ensureStarterLicense({
    seedMarker,
    maxAccounts: starterMaxAccounts,
    expiresAt,
    createdBy: admin?._id || null
  });

  const starterUser = await ensureStarterUser({
    username: starterUsername,
    email: starterEmail,
    password: starterPassword,
    licenseId: starterLicense._id,
    resetPassword: resetPasswords
  });

  console.log("");
  console.log("[seed] Bootstrap seed complete");
  console.log(`[seed] Admin:    ${admin.username} (${admin.email})`);
  console.log(`[seed] Starter:  ${starterUser.username} (${starterUser.email})`);
  console.log(`[seed] License:  ${starterLicense.key} (max=${starterLicense.maxAccounts}, status=${starterLicense.status})`);
}

main()
  .catch((error) => {
    console.error(`[seed] Failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close().catch(() => null);
    }
  });
