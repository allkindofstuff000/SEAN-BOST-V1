#!/usr/bin/env node
require("dotenv").config();

class CookieJar {
  constructor() {
    this.map = new Map();
  }

  updateFromResponseHeaders(headers) {
    const setCookieValues = getSetCookieValues(headers);
    for (const rawCookie of setCookieValues) {
      const parsed = parseCookiePair(rawCookie);
      if (!parsed) continue;
      this.map.set(parsed.name, parsed.pair);
    }
  }

  toHeader() {
    return Array.from(this.map.values()).join("; ");
  }
}

function envString(name, fallback = "") {
  const value = process.env[name];
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function getSetCookieValues(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const singleValue = headers.get("set-cookie");
  if (!singleValue) return [];
  return [singleValue];
}

function parseCookiePair(rawSetCookie) {
  const raw = String(rawSetCookie || "").trim();
  if (!raw) return null;

  const pair = raw.split(";")[0].trim();
  const separator = pair.indexOf("=");
  if (separator < 1) return null;

  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (!name || !value) return null;

  return {
    name,
    value,
    pair: `${name}=${value}`
  };
}

function buildUrl(baseUrl, path) {
  const normalizedBase = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedPath = String(path || "");
  if (normalizedPath.startsWith("http://") || normalizedPath.startsWith("https://")) {
    return normalizedPath;
  }
  return `${normalizedBase}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
}

async function requestJson({
  baseUrl,
  jar,
  method = "GET",
  path,
  body
}) {
  const headers = {
    Accept: "application/json"
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (jar) {
    const cookie = jar.toHeader();
    if (cookie) headers.Cookie = cookie;
  }

  const response = await fetch(buildUrl(baseUrl, path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (jar) {
    jar.updateFromResponseHeaders(response.headers);
  }

  const rawText = await response.text();
  let payload = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = rawText;
  }

  return {
    status: response.status,
    ok: response.ok,
    body: payload
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertStatus(response, expectedStatus, message) {
  assert(
    response.status === expectedStatus,
    `${message} (expected ${expectedStatus}, got ${response.status})`
  );
}

function assertContains(haystack, needle, message) {
  const source = String(haystack || "").toLowerCase();
  const target = String(needle || "").toLowerCase();
  assert(source.includes(target), `${message} (missing "${needle}")`);
}

function printStep(step) {
  console.log(`[smoke] ${step}`);
}

async function main() {
  const baseUrl = envString(
    "SMOKE_BASE_URL",
    `http://127.0.0.1:${envString("PORT", "5000")}`
  );

  const adminIdentifier = envString(
    "SMOKE_ADMIN_IDENTIFIER",
    envString("SEED_ADMIN_EMAIL", envString("ADMIN_EMAIL", "admin@megaboost.local"))
  );
  const adminPassword = envString(
    "SMOKE_ADMIN_PASSWORD",
    envString("SEED_ADMIN_PASSWORD", envString("ADMIN_PASSWORD", "Admin123!"))
  );
  const smokeUserPassword = envString("SMOKE_USER_PASSWORD", "Smoke123!");

  const suffix = Date.now().toString(36);
  const smokeUsername = `smoke_user_${suffix}`;
  const smokeEmail = `smoke.${suffix}@example.com`;

  const adminJar = new CookieJar();
  const userJar = new CookieJar();

  printStep(`Base URL: ${baseUrl}`);

  printStep("Login as admin");
  const adminLogin = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "POST",
    path: "/api/auth/login",
    body: {
      identifier: adminIdentifier,
      password: adminPassword
    }
  });
  assertStatus(
    adminLogin,
    200,
    "Admin login failed. Run npm run seed:bootstrap or verify SMOKE_ADMIN_* env vars."
  );
  assert(
    String(adminLogin.body?.data?.role || "").toLowerCase() === "admin",
    "Logged-in account is not admin"
  );

  printStep("Validate admin session");
  const adminMe = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "GET",
    path: "/api/auth/me"
  });
  assertStatus(adminMe, 200, "GET /api/auth/me failed for admin");

  printStep("GET /api/admin/overview");
  const adminOverview = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "GET",
    path: "/api/admin/overview"
  });
  assertStatus(adminOverview, 200, "GET /api/admin/overview failed");

  const twoDaysFromNow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  printStep("Create active license");
  const activeLicenseRes = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "POST",
    path: "/api/admin/licenses",
    body: {
      maxAccounts: 1,
      expiresAt: twoDaysFromNow,
      notes: `smoke-active-${suffix}`
    }
  });
  assertStatus(activeLicenseRes, 201, "POST /api/admin/licenses (active) failed");
  const activeLicense = activeLicenseRes.body?.data;
  assert(activeLicense?._id, "Active license _id missing");
  assertContains(activeLicense.key, "SB-", "Active license key format invalid");

  printStep("Create revoked license");
  const revokedLicenseRes = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "POST",
    path: "/api/admin/licenses",
    body: {
      maxAccounts: 1,
      expiresAt: twoDaysFromNow,
      notes: `smoke-revoked-${suffix}`
    }
  });
  assertStatus(revokedLicenseRes, 201, "POST /api/admin/licenses (revoked candidate) failed");
  const revokedLicense = revokedLicenseRes.body?.data;
  assert(revokedLicense?._id, "Revoked candidate license _id missing");

  const revokeResponse = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "PUT",
    path: `/api/admin/licenses/${revokedLicense._id}`,
    body: {
      status: "revoked"
    }
  });
  assertStatus(revokeResponse, 200, "PUT /api/admin/licenses/:id revoke failed");

  printStep("Create expired license");
  const expiredLicenseRes = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "POST",
    path: "/api/admin/licenses",
    body: {
      maxAccounts: 1,
      expiresAt: yesterday,
      notes: `smoke-expired-${suffix}`
    }
  });
  assertStatus(expiredLicenseRes, 201, "POST /api/admin/licenses (expired) failed");
  const expiredLicense = expiredLicenseRes.body?.data;
  assert(expiredLicense?._id, "Expired license _id missing");

  printStep("GET /api/admin/licenses");
  const listLicenses = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "GET",
    path: "/api/admin/licenses?page=1&limit=10&q=smoke"
  });
  assertStatus(listLicenses, 200, "GET /api/admin/licenses failed");

  printStep("Create smoke user with active license");
  const createUserRes = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "POST",
    path: "/api/admin/users",
    body: {
      username: smokeUsername,
      email: smokeEmail,
      password: smokeUserPassword,
      role: "user",
      licenseId: activeLicense._id
    }
  });
  assertStatus(createUserRes, 201, "POST /api/admin/users failed");
  const smokeUser = createUserRes.body?.data;
  assert(smokeUser?._id, "Created user _id missing");

  printStep("GET /api/admin/users");
  const listUsers = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "GET",
    path: "/api/admin/users?page=1&limit=10&q=smoke_user"
  });
  assertStatus(listUsers, 200, "GET /api/admin/users failed");

  printStep("Login as smoke user");
  const userLogin = await requestJson({
    baseUrl,
    jar: userJar,
    method: "POST",
    path: "/api/auth/login",
    body: {
      identifier: smokeEmail,
      password: smokeUserPassword
    }
  });
  assertStatus(userLogin, 200, "Smoke user login failed");

  printStep("GET /api/license/me for smoke user");
  const licenseMe = await requestJson({
    baseUrl,
    jar: userJar,
    method: "GET",
    path: "/api/license/me"
  });
  assertStatus(licenseMe, 200, "GET /api/license/me failed");
  assertContains(
    licenseMe.body?.data?.key || "",
    "****",
    "Non-admin license key should be masked"
  );
  assert(
    String(licenseMe.body?.data?.status || "").toLowerCase() === "active",
    "Expected active license status for smoke user"
  );

  printStep("Assign revoked license and verify enforcement");
  const assignRevoked = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "PUT",
    path: `/api/admin/users/${smokeUser._id}`,
    body: {
      licenseId: revokedLicense._id
    }
  });
  assertStatus(assignRevoked, 200, "Assign revoked license failed");

  const revokedEnforcement = await requestJson({
    baseUrl,
    jar: userJar,
    method: "POST",
    path: "/api/accounts/start-all",
    body: {}
  });
  assertStatus(revokedEnforcement, 403, "Expected revoked license enforcement 403");
  assertContains(
    revokedEnforcement.body?.message || "",
    "revoked",
    "Expected 'License revoked' message"
  );

  printStep("Assign expired license and verify enforcement");
  const assignExpired = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "PUT",
    path: `/api/admin/users/${smokeUser._id}`,
    body: {
      licenseId: expiredLicense._id
    }
  });
  assertStatus(assignExpired, 200, "Assign expired license failed");

  const expiredEnforcement = await requestJson({
    baseUrl,
    jar: userJar,
    method: "POST",
    path: "/api/accounts/start-all",
    body: {}
  });
  assertStatus(expiredEnforcement, 403, "Expected expired license enforcement 403");
  assertContains(
    expiredEnforcement.body?.message || "",
    "expired",
    "Expected 'License expired' message"
  );

  printStep("Unassign license and verify enforcement");
  const clearLicense = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "PUT",
    path: `/api/admin/users/${smokeUser._id}`,
    body: {
      licenseId: null
    }
  });
  assertStatus(clearLicense, 200, "Clearing user license failed");

  const noLicenseEnforcement = await requestJson({
    baseUrl,
    jar: userJar,
    method: "POST",
    path: "/api/accounts/start-all",
    body: {}
  });
  assertStatus(noLicenseEnforcement, 403, "Expected no-license enforcement 403");
  assertContains(
    noLicenseEnforcement.body?.message || "",
    "no license",
    "Expected 'No license assigned' message"
  );

  printStep("Re-assign active license and verify path unblocked");
  const assignActive = await requestJson({
    baseUrl,
    jar: adminJar,
    method: "PUT",
    path: `/api/admin/users/${smokeUser._id}`,
    body: {
      licenseId: activeLicense._id
    }
  });
  assertStatus(assignActive, 200, "Re-assign active license failed");

  const activePath = await requestJson({
    baseUrl,
    jar: userJar,
    method: "POST",
    path: "/api/accounts/start-all",
    body: {}
  });
  assertStatus(activePath, 200, "Expected active license to allow /api/accounts/start-all");

  console.log("");
  console.log("[smoke] PASS");
  console.log(`[smoke] Created user: ${smokeEmail}`);
  console.log(`[smoke] Created licenses: ${activeLicense._id}, ${revokedLicense._id}, ${expiredLicense._id}`);
}

main().catch((error) => {
  console.error(`[smoke] FAIL: ${error.message}`);
  process.exit(1);
});
