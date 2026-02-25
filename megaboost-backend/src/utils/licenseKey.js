const crypto = require("crypto");

function generateChunk() {
  return crypto.randomBytes(2).toString("hex").toUpperCase();
}

function normalizePrefix(prefix = "SB") {
  const normalized = String(prefix || "SB")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return normalized || "SB";
}

function generateLicenseKey(prefix = "SB") {
  const safePrefix = normalizePrefix(prefix);
  return `${safePrefix}-${generateChunk()}-${generateChunk()}-${generateChunk()}`;
}

function maskLicenseKey(key) {
  const raw = String(key || "").trim().toUpperCase();
  const match = raw.match(/^([A-Z0-9]+)-([A-F0-9]{4})-([A-F0-9]{4})-([A-F0-9]{4})$/);
  if (!match) {
    return raw ? `${raw.slice(0, 6)}****${raw.slice(-4)}` : "";
  }

  const [, prefix, first, , last] = match;
  return `${prefix}-${first}-****-${last}`;
}

module.exports = {
  generateLicenseKey,
  maskLicenseKey
};
