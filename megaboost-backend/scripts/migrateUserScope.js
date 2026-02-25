#!/usr/bin/env node
require("dotenv").config();

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const User = require("../src/model/User");
const Account = require("../src/model/Account");
const Log = require("../src/model/Log");
const AppSettings = require("../src/model/AppSettings");

const SALT_ROUNDS = 10;

function envString(name, fallback = "") {
  const value = process.env[name];
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function missingUserFilter() {
  return {
    $or: [
      { userId: { $exists: false } },
      { userId: null }
    ]
  };
}

async function ensureDefaultAdminUser() {
  const earliestAdmin = await User.findOne({ role: "admin" })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  if (earliestAdmin?._id) {
    return earliestAdmin;
  }

  const email = envString("ADMIN_EMAIL", "admin@megaboost.local").toLowerCase();
  const username = envString("ADMIN_USERNAME", "admin");
  const password = envString("ADMIN_PASSWORD", "Admin123!");

  const existing = await User.findOne({
    $or: [{ email }, { username }]
  });
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  if (existing) {
    const patch = {};
    if (existing.role !== "admin") patch.role = "admin";
    if (existing.isActive === false) patch.isActive = true;
    patch.passwordHash = passwordHash;

    const updated = await User.findByIdAndUpdate(
      existing._id,
      { $set: patch },
      { new: true }
    ).lean();
    return updated;
  }

  const created = await User.create({
    username,
    email,
    passwordHash,
    role: "admin",
    isActive: true
  });
  return created.toObject ? created.toObject() : created;
}

function shouldUseValue(primaryValue, incomingValue) {
  const hasPrimary = String(primaryValue || "").trim().length > 0;
  const hasIncoming = String(incomingValue || "").trim().length > 0;
  return !hasPrimary && hasIncoming;
}

async function migrateAppSettings(defaultUserId) {
  let updated = 0;
  let deleted = 0;
  let merged = 0;
  let created = 0;

  let target = await AppSettings.findOne({ userId: defaultUserId });
  const missingDocs = await AppSettings.find(missingUserFilter()).sort({
    createdAt: 1,
    _id: 1
  });

  if (!target && missingDocs.length > 0) {
    const first = missingDocs.shift();
    const setResult = await AppSettings.updateOne(
      { _id: first._id },
      {
        $set: { userId: defaultUserId },
        $unset: { key: "" }
      }
    );
    updated += Number(setResult.modifiedCount || 0);
    target = await AppSettings.findById(first._id);
  }

  if (!target) {
    target = await AppSettings.create({
      userId: defaultUserId,
      telegramEnabled: false,
      telegramBotToken: "",
      telegramChatId: ""
    });
    created += 1;
  }

  for (const doc of missingDocs) {
    const patch = {};
    if (shouldUseValue(target.telegramBotToken, doc.telegramBotToken)) {
      patch.telegramBotToken = String(doc.telegramBotToken || "").trim();
    }
    if (shouldUseValue(target.telegramChatId, doc.telegramChatId)) {
      patch.telegramChatId = String(doc.telegramChatId || "").trim();
    }
    if (!target.telegramEnabled && doc.telegramEnabled) {
      patch.telegramEnabled = true;
    }

    if (Object.keys(patch).length > 0) {
      const mergedDoc = await AppSettings.findByIdAndUpdate(
        target._id,
        { $set: patch },
        { new: true }
      );
      target = mergedDoc || target;
      merged += 1;
    }

    await AppSettings.deleteOne({ _id: doc._id });
    deleted += 1;
  }

  const duplicates = await AppSettings.aggregate([
    {
      $group: {
        _id: "$userId",
        ids: { $push: "$_id" },
        count: { $sum: 1 }
      }
    },
    {
      $match: {
        _id: { $ne: null },
        count: { $gt: 1 }
      }
    }
  ]);

  for (const row of duplicates) {
    const docs = await AppSettings.find({ _id: { $in: row.ids } })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    const keepId = String(docs[0]?._id || "");
    for (let index = 1; index < docs.length; index += 1) {
      await AppSettings.deleteOne({ _id: docs[index]._id });
      deleted += 1;
    }

    if (keepId && !String(docs[0]?.userId || "").trim()) {
      const fixResult = await AppSettings.updateOne(
        { _id: keepId },
        { $set: { userId: defaultUserId }, $unset: { key: "" } }
      );
      updated += Number(fixResult.modifiedCount || 0);
    }
  }

  return {
    updated,
    deleted,
    merged,
    created
  };
}

async function dropLegacyAppSettingsKeyIndexes() {
  let dropped = 0;
  const indexes = await AppSettings.collection.indexes().catch(() => []);
  for (const index of indexes) {
    if (index?.name === "_id_") continue;
    if (index?.key && Object.prototype.hasOwnProperty.call(index.key, "key")) {
      await AppSettings.collection.dropIndex(index.name).catch(() => null);
      dropped += 1;
    }
  }
  return dropped;
}

async function main() {
  await connectDB();

  const defaultAdmin = await ensureDefaultAdminUser();
  const defaultUserId = defaultAdmin?._id;
  if (!defaultUserId) {
    throw new Error("Could not resolve default admin user for migration");
  }

  const droppedLegacyIndexes = await dropLegacyAppSettingsKeyIndexes();

  const accountResult = await Account.updateMany(
    missingUserFilter(),
    { $set: { userId: defaultUserId } }
  );
  const logResult = await Log.updateMany(
    missingUserFilter(),
    { $set: { userId: defaultUserId } }
  );
  const settingsResult = await migrateAppSettings(defaultUserId);
  await AppSettings.collection
    .createIndex({ userId: 1 }, { unique: true })
    .catch(() => null);

  const accountUpdated = Number(accountResult.modifiedCount || 0);
  const logUpdated = Number(logResult.modifiedCount || 0);

  console.log("[migrate:user-scope] complete");
  console.log(
    `[migrate:user-scope] default_admin=${defaultAdmin.email} userId=${defaultUserId}`
  );
  console.log(`[migrate:user-scope] accounts_updated=${accountUpdated}`);
  console.log(`[migrate:user-scope] logs_updated=${logUpdated}`);
  console.log(
    `[migrate:user-scope] settings_updated=${settingsResult.updated} settings_created=${settingsResult.created} settings_merged=${settingsResult.merged} settings_deleted=${settingsResult.deleted}`
  );
  console.log(
    `[migrate:user-scope] app_settings_legacy_indexes_dropped=${droppedLegacyIndexes}`
  );
}

main()
  .catch((error) => {
    console.error(`[migrate:user-scope] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close().catch(() => null);
    }
  });
