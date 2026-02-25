const jwt = require("jsonwebtoken");

const AUTH_COOKIE_NAME = "mb_auth";
const AUTH_TOKEN_TTL = process.env.AUTH_TOKEN_TTL || "7d";

function parseBooleanEnv(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

function shouldUseSecureCookies() {
  const explicit = parseBooleanEnv(process.env.COOKIE_SECURE);
  if (explicit !== null) return explicit;

  const origin =
    String(process.env.APP_ORIGIN || "").trim() ||
    String(process.env.FRONTEND_URLS || "").split(",")[0]?.trim() ||
    "";

  if (origin.toLowerCase().startsWith("https://")) {
    return true;
  }

  return false;
}

function getAuthSecret() {
  return process.env.AUTH_SECRET || "megaboost-dev-secret-change-me";
}

function signAuthToken(payload) {
  return jwt.sign(payload, getAuthSecret(), {
    expiresIn: AUTH_TOKEN_TTL
  });
}

function verifyAuthToken(token) {
  return jwt.verify(token, getAuthSecret());
}

function getAuthCookieOptions() {
  const secure = shouldUseSecureCookies();
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}

module.exports = {
  AUTH_COOKIE_NAME,
  signAuthToken,
  verifyAuthToken,
  getAuthCookieOptions
};
