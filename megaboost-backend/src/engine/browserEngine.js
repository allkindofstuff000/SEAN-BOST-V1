const fs = require("fs");
const path = require("path");
const Account = require("../model/Account");
const { updateStatus } = require("./statusManager");
const { launchBrowser } = require("./accountEngine");
const { solveCaptcha, solveCaptchaBase64, isConfigured } = require("../utils/captchaSolver");
const { logActivity } = require("../utils/activityLogger");
const { emitAccountUpdate, emitToUser } = require("../utils/socketEvents");

const ROOT_URL = "https://megapersonals.eu";
const POSTS_LIST_URL = `${ROOT_URL}/users/posts/list`;
const BANNED_MESSAGE_SELECTOR = ".banned-message-small";
const LOGS_DIR = path.join(__dirname, "..", "..", "logs");
const COOKIES_DIR = path.join(__dirname, "..", "..", "cookies");
const CAPTCHA_SESSION_TTL_MS = Number(process.env.CAPTCHA_SESSION_TTL_MS || 10 * 60 * 1000);
const VERIFICATION_SESSION_TTL_MS = Number(process.env.VERIFICATION_SESSION_TTL_MS || 5 * 60 * 1000);
const CAPTCHA_SUBMIT_TIMEOUT_MS = Number(process.env.CAPTCHA_SUBMIT_TIMEOUT_MS || 30000);
const TWO_FACTOR_TIMEOUT_MS = Number(process.env.TWO_FACTOR_TIMEOUT_MS || 45000);
const TWO_FACTOR_HTML_SNAPSHOT_LIMIT = Number(
  process.env.TWO_FACTOR_HTML_SNAPSHOT_LIMIT || 200 * 1024
);
const TWO_FACTOR_ALLOWED_STATUSES = new Set([
  "awaiting_2fa",
  "needs_2fa",
  "needs2fa",
  "awaiting_verification_code"
]);
const TWO_FACTOR_INPUT_SELECTORS = [
  "#verificationCode",
  "input[name='verificationCode']",
  "input.form-control.phone-input-code",
  "input[type='text'][id*='verification']"
];
const TWO_FACTOR_SUBMIT_SELECTORS = [
  "#device_verification_submit",
  "button[type='submit']",
  "button.btn.btn-warning"
];
const TWO_FACTOR_OK_SELECTORS = [
  "button#successful-device-verification",
  "#OK",
  ".modal button",
  ".swal2-confirm",
  "button.btn"
];
const TWO_FACTOR_SUCCESS_URL_PATTERNS = [
  "/users/device-verification/successful/",
  "/users/device-verification/success"
];
const pendingCaptchaSessions = new Map();
const pendingVerificationSessions = new Map();

function getManualLoginConfig() {
  return {
    LOGIN_URL: process.env.LOGIN_URL || "https://megapersonals.eu/users/auth/login",
    USER_SELECTOR: process.env.USER_SELECTOR || "#email, input[name='email'], input[name='username'], input[type='email'], input[id='email']",
    PASS_SELECTOR: process.env.PASS_SELECTOR || "#password, input[name='password'], input[type='password'], input[id='password']",
    CAPTCHA_IMG_SELECTOR: process.env.CAPTCHA_IMG_SELECTOR || "#captcha_image_itself, img.captcha, img[src*='captcha']",
    CAPTCHA_INPUT_SELECTOR: process.env.CAPTCHA_INPUT_SELECTOR || "#captcha_code, input[name='captcha'], input[placeholder*='code'], input[id='captcha_code']",
    SUBMIT_SELECTOR: process.env.SUBMIT_SELECTOR || "#submit, button[type='submit'], input[type='submit']"
  };
}

function getVerificationConfig() {
  return {
    CHECKPOINT_URL_MATCH: process.env.CHECKPOINT_URL_MATCH || "/users/device-verification/verify/",
    VERIFICATION_INPUT_SELECTOR: process.env.VERIFICATION_INPUT_SELECTOR || "#verificationCode, .form-control.phone-input-code",
    VERIFICATION_SUBMIT_SELECTOR: process.env.VERIFICATION_SUBMIT_SELECTOR || "#device_verification_submit, button[type='submit'], input[type='submit']",
    VERIFICATION_OK_SELECTOR: process.env.VERIFICATION_OK_SELECTOR || "#OK"
  };
}

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function ensureCookiesDir() {
  if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
  }
}

function getCookieFilePath(accountId) {
  return path.join(COOKIES_DIR, `${String(accountId)}.json`);
}

async function loadCookiesForAccount(page, account) {
  try {
    ensureCookiesDir();
    const cookieFile = getCookieFilePath(account._id);
    const raw = await fs.promises.readFile(cookieFile, "utf8");
    const cookies = JSON.parse(raw);

    if (!Array.isArray(cookies) || cookies.length === 0) {
      return false;
    }

    await page.setCookie(...cookies);
    console.log(`[COOKIES] Loaded cookies for ${account.email}`);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[COOKIES] Failed loading cookies for ${account.email}: ${error.message}`);
    }
    return false;
  }
}

async function saveCookiesForAccount(page, account) {
  const accountId = account?._id || account?.id || account?.accountId;
  const email = account?.email || String(accountId || "unknown");
  if (!accountId) {
    throw new Error("Cannot save cookies without account id");
  }

  ensureCookiesDir();
  const cookieFile = getCookieFilePath(accountId);
  const cookies = await page.cookies();

  await fs.promises.writeFile(cookieFile, JSON.stringify(cookies, null, 2), "utf8");
  await Account.findByIdAndUpdate(accountId, {
    cookiesSavedAt: new Date()
  }).catch(() => null);

  console.log(`[COOKIES] Saved ${cookies.length} cookies for ${email}`);
}

async function validateCookiesForAccount(page, account) {
  try {
    await page.goto(POSTS_LIST_URL, {
      waitUntil: "networkidle2",
      timeout: 90000
    });
    const valid = page.url().includes("/users/posts/list");
    if (valid) {
      console.log(`[COOKIES] Session restored for ${account.email}`);
    }
    return valid;
  } catch {
    return false;
  }
}

async function getUserAgentSafe(page) {
  if (!page || page.isClosed()) return "";
  try {
    return await page.evaluate(() => navigator.userAgent);
  } catch {
    return "";
  }
}

async function getPageTitleSafe(page) {
  if (!page || page.isClosed()) return "";
  try {
    return await page.title();
  } catch {
    return "";
  }
}

function isSafeStatusForCatch(status) {
  const value = String(status || "")
    .trim()
    .toLowerCase();
  return [
    "active",
    "bumping",
    "waiting_cooldown",
    "completed",
    "awaiting_captcha",
    "awaiting_verification_code",
    "awaiting_2fa"
  ].includes(value);
}

function safeFilePart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toPublicLogPath(fileName) {
  return `/logs/${fileName}`;
}

function toPublicLogSubPath(...segments) {
  return `/logs/${path.posix.join(...segments.map((segment) => String(segment || "").replace(/\\/g, "/")))}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min = 300, max = 800) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function findElementBySelectors(page, selectors) {
  const selectorList = selectors.split(",").map(s => s.trim());
  for (const sel of selectorList) {
    try {
      const el = await page.$(sel);
      if (el) return el;
    } catch {}
  }
  return null;
}

async function waitForElementBySelectors(page, selectors, options = {}) {
  const selectorList = selectors.split(",").map(s => s.trim());
  for (const sel of selectorList) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: options.timeout || 5000 });
      return sel;
    } catch {}
  }
  throw new Error(`None of the selectors found: ${selectors}`);
}

async function findAndClickSubmitButton(page, submitSelector) {
  console.log("Ã°Å¸â€Â Searching for submit button...");
  
  // First try the configured selector
  if (submitSelector) {
    try {
      const button = await page.$(submitSelector);
      if (button) {
        const isVisible = await button.isIntersectingViewport();
        if (isVisible) {
          console.log(`Ã¢Å“â€¦ Found submit button with selector: ${submitSelector}`);
          await button.click();
          return true;
        }
      }
    } catch (err) {
      console.log(`Configured selector ${submitSelector} failed:`, err.message);
    }
  }

  // Try multiple common submit button selectors
  const selectors = [
    '#submit',
    '#login_submit', 
    'button[type="submit"]',
    'input[type="submit"]',
    'button.btn-primary',
    'button.submit-btn',
    'button.login-btn',
    '.submit-button',
    'form button',
    'button:has-text("Login")',
    'button:has-text("SIGN IN")',
    'button:has-text("Submit")',
    'input[value="Login"]',
    'input[value="SIGN IN"]'
  ];

  for (const sel of selectors) {
    try {
      const button = await page.$(sel);
      if (button) {
        const isVisible = await button.isIntersectingViewport();
        if (isVisible) {
          console.log(`Ã¢Å“â€¦ Found submit button with selector: ${sel}`);
          await button.click();
          return true;
        }
      }
    } catch {}
  }

  // Try XPath for text-based matching
  console.log("Ã¢Å¡Â Ã¯Â¸Â CSS selectors failed, trying XPath...");
  const textSelectors = [
    "//button[contains(translate(text(), 'LOGIN', 'login'), 'login')]",
    "//button[contains(translate(text(), 'SUBMIT', 'submit'), 'submit')]", 
    "//input[@type='submit']",
    "//button[@type='submit']",
    "//button[contains(@class, 'btn')]",
  ];

  for (const xpath of textSelectors) {
    try {
      const elements = await page.$x(xpath);
      if (elements.length > 0) {
        console.log(`Ã¢Å“â€¦ Found submit button with XPath: ${xpath}`);
        await elements[0].click();
        return true;
      }
    } catch {}
  }

  // Last resort: Find by evaluating all buttons
  console.log("Ã¢Å¡Â Ã¯Â¸Â XPath failed, trying page.evaluate...");
  const clicked = await page.evaluate(() => {
    const form = document.querySelector('form');
    if (!form) return false;

    const buttons = form.querySelectorAll('button, input[type="submit"], a.btn');
    for (const btn of buttons) {
      const text = btn.textContent || btn.value || '';
      const lowerText = text.toLowerCase();
      
      if (lowerText.includes('login') || 
          lowerText.includes('submit') || 
          lowerText.includes('sign in') ||
          btn.type === 'submit') {
        btn.click();
        return true;
      }
    }
    
    if (form.querySelector('input[type="password"]')) {
      form.submit();
      return true;
    }
    
    return false;
  });

  if (clicked) {
    console.log("Ã¢Å“â€¦ Submit triggered via page.evaluate");
    return true;
  }

  throw new Error('Submit button not found');
}

async function writeBootLog(fileStem, logPayload) {
  ensureLogsDir();
  const logPath = path.join(LOGS_DIR, `${fileStem}-boot.json`);
  await fs.promises.writeFile(logPath, JSON.stringify(logPayload, null, 2), "utf8");
}

function resolveCaptchaInputSelector(loginConfig) {
  return loginConfig.CAPTCHA_INPUT_SELECTOR || "#captcha_code";
}

async function resolveCaptchaImageUrl(page, loginConfig) {
  let captchaImg = await page.$("#captcha_image_itself");
  if (!captchaImg) captchaImg = await page.$(loginConfig.CAPTCHA_IMG_SELECTOR);
  if (!captchaImg) captchaImg = await page.$('img[src*="/captchas/"], img[src*="captcha"]');
  if (!captchaImg) return null;
  const rawCaptchaSrc = await page.evaluate((el) => el.getAttribute("src") || "", captchaImg);
  return rawCaptchaSrc ? new URL(rawCaptchaSrc, page.url()).href : null;
}

async function detectCaptchaFailureReason(page) {
  const failureText = await page.evaluate(() => {
    const bodyText = (document.body?.innerText || "").toLowerCase();
    if (bodyText.includes("wrong captcha") || bodyText.includes("invalid captcha")) return "wrong_captcha";
    if (bodyText.includes("captcha required") || bodyText.includes("enter code from the picture")) return "captcha_required";
    return "";
  });
  return failureText || null;
}

function clearPendingCaptchaSession(accountId) {
  const key = String(accountId);
  const session = pendingCaptchaSessions.get(key);
  if (session?.expiryTimer) clearTimeout(session.expiryTimer);
  pendingCaptchaSessions.delete(key);
}

function clearPendingVerificationSession(accountId) {
  const key = String(accountId);
  const session = pendingVerificationSessions.get(key);
  if (session?.expiryTimer) clearTimeout(session.expiryTimer);
  pendingVerificationSessions.delete(key);
}

function normalizeAccountStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function isPostsListUrl(url) {
  return String(url || "").includes("/users/posts/list");
}

function resolveProxyLabel(account, fallbackIp = "") {
  const host = String(account?.proxyHost || "").trim();
  const port = Number(account?.proxyPort);
  if (host && Number.isFinite(port) && port > 0) {
    return `${host}:${port}`;
  }
  if (host) {
    return host;
  }
  return String(fallbackIp || "").trim() || "unknown";
}

async function detectBannedState(page) {
  return page
    .evaluate((selector) => {
      const node = document.querySelector(selector);
      if (!node) {
        return {
          banned: false,
          text: ""
        };
      }

      const text = String(node.innerText || node.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);

      return {
        banned: true,
        text
      };
    }, BANNED_MESSAGE_SELECTOR)
    .catch(() => ({
      banned: false,
      text: ""
    }));
}

async function handleBannedAccount(page, account, options = {}) {
  if (!page || page.isClosed()) {
    return { banned: false };
  }

  const probe = await detectBannedState(page);
  if (!probe?.banned) {
    return { banned: false };
  }

  const ip = String(options?.ip || "").trim();
  const proxy = resolveProxyLabel(account, options?.proxyIp || ip);
  const reason = String(options?.reason || "banned_message_detected");
  const currentUrl = String(page.url() || "");
  const message = `Account ${account.email} was banned through IP ${proxy}`;

  console.error(`[BANNED] ${message}`);
  if (probe.text) {
    console.error(`[BANNED] Matched text: ${probe.text}`);
  }

  await Account.findByIdAndUpdate(account._id, {
    status: "banned",
    waitingUntil: null,
    nextBumpAt: null,
    nextBumpDelayMs: null
  }).catch(() => null);

  await updateStatus(account._id, "banned", {
    ip,
    email: account.email,
    metadata: {
      reason,
      proxy,
      url: currentUrl
    }
  }).catch(() => null);

  await logActivity({
    level: "error",
    message,
    ip,
    email: account.email,
    accountId: account._id,
    metadata: {
      reason,
      proxy,
      url: currentUrl,
      matchedSelector: BANNED_MESSAGE_SELECTOR,
      bannedMessage: probe.text || undefined
    }
  }).catch(() => null);

  if (global.io) {
    const eventPayload = {
      type: "account_banned",
      accountId: String(account._id),
      userId: String(account.userId || ""),
      email: account.email,
      proxy,
      reason,
      url: currentUrl,
      timestamp: new Date().toISOString()
    };
    emitToUser(global.io, account.userId, "account:banned", eventPayload);
    emitToUser(global.io, account.userId, "account:event", eventPayload);
    await emitAccountUpdate(global.io, account, {
      status: "banned",
      waitingUntil: null,
      nextBumpAt: null,
      nextBumpDelayMs: null
    });
  }

  return {
    banned: true,
    reason,
    proxy,
    currentUrl,
    text: probe.text
  };
}

function isTwoFactorSuccessUrl(url) {
  const value = String(url || "").toLowerCase();
  return TWO_FACTOR_SUCCESS_URL_PATTERNS.some((pattern) =>
    value.includes(String(pattern).toLowerCase())
  );
}

function createTwoFactorError({
  status = 500,
  code = "2FA_SUBMIT_FAILED",
  message = "2FA submission failed",
  hint,
  url,
  title,
  diagnostics
} = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.payload = {
    success: false,
    code,
    message,
    ...(hint ? { hint } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...(diagnostics?.screenshotPath ? { screenshotPath: diagnostics.screenshotPath } : {}),
    ...(diagnostics?.htmlPath ? { htmlPath: diagnostics.htmlPath } : {}),
    ...(diagnostics?.screenshotUrl ? { screenshotUrl: diagnostics.screenshotUrl } : {}),
    ...(diagnostics?.htmlUrl ? { htmlUrl: diagnostics.htmlUrl } : {})
  };
  return error;
}

async function waitForAnySelector(page, selectors, { timeout = 10000, visible = true } = {}) {
  const selectorList = (Array.isArray(selectors) ? selectors : [selectors])
    .flatMap((entry) => String(entry || "").split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (selectorList.length === 0) {
    return null;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const contexts = [page, ...(typeof page.frames === "function" ? page.frames() : [])];

    for (const selector of selectorList) {
      for (const context of contexts) {
        try {
          const element = await context.$(selector);
          if (!element) continue;

          if (!visible) {
            return {
              selector,
              element,
              frame: typeof context.url === "function" && context !== page ? context : null
            };
          }

          const isVisible = await element.evaluate((node) => {
            if (!node) return false;
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.opacity !== "0" &&
              rect.width > 0 &&
              rect.height > 0
            );
          });

          if (isVisible) {
            return {
              selector,
              element,
              frame: typeof context.url === "function" && context !== page ? context : null
            };
          }
        } catch {
          // Try next selector/frame.
        }
      }
    }

    await sleep(250);
  }

  return null;
}

async function capture2FADiagnostics(page, accountId, email, stepName) {
  ensureLogsDir();
  const safeEmail = safeFilePart(email || accountId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const step = safeFilePart(stepName || "2fa");

  const screenshotsDir = path.join(LOGS_DIR, "screenshots", safeEmail);
  const htmlDir = path.join(LOGS_DIR, "html", safeEmail);

  await fs.promises.mkdir(screenshotsDir, { recursive: true });
  await fs.promises.mkdir(htmlDir, { recursive: true });

  const screenshotPath = path.join(screenshotsDir, `${timestamp}-${step}.png`);
  const htmlPath = path.join(htmlDir, `${timestamp}-${step}.html`);
  const metaPath = path.join(LOGS_DIR, `${safeEmail}-${timestamp}-${step}-diag.json`);

  const url = page?.url?.() || "";
  let title = "";
  try {
    title = await page.title();
  } catch {}

  try {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
  } catch (error) {
    console.error("[2FA] Failed to save diagnostics screenshot:", error.message);
  }

  try {
    if (page && !page.isClosed()) {
      const html = await page.content();
      const htmlSlice = String(html || "").slice(0, TWO_FACTOR_HTML_SNAPSHOT_LIMIT);
      await fs.promises.writeFile(htmlPath, htmlSlice, "utf8");
    }
  } catch (error) {
    console.error("[2FA] Failed to save diagnostics HTML:", error.message);
  }

  const diagnostics = {
    accountId: String(accountId),
    email,
    step: stepName,
    timestamp: new Date().toISOString(),
    url,
    title,
    screenshotPath,
    htmlPath,
    screenshotUrl: toPublicLogSubPath("screenshots", safeEmail, `${timestamp}-${step}.png`),
    htmlUrl: toPublicLogSubPath("html", safeEmail, `${timestamp}-${step}.html`)
  };

  try {
    await fs.promises.writeFile(metaPath, JSON.stringify(diagnostics, null, 2), "utf8");
  } catch (error) {
    console.error("[2FA] Failed to save diagnostics metadata:", error.message);
  }

  return diagnostics;
}

async function inspectTwoFactorPage(page) {
  const url = page.url();
  let title = "";
  try {
    title = await page.title();
  } catch {}

  const inputProbe = await waitForAnySelector(page, TWO_FACTOR_INPUT_SELECTORS, {
    timeout: 2500
  });
  const submitProbe = await waitForAnySelector(page, TWO_FACTOR_SUBMIT_SELECTORS, {
    timeout: 2500
  });

  const textHint = await page
    .evaluate(() => {
      const text = String(document.body?.innerText || "").toLowerCase();
      if (!text) return "";
      if (text.includes("enter the code")) return "enter_the_code";
      if (text.includes("verification code")) return "verification_code";
      if (text.includes("device verification")) return "device_verification";
      if (text.includes("2fa")) return "2fa";
      return "";
    })
    .catch(() => "");

  const onVerificationUrl =
    url.includes("/device-verification") || url.includes("/verification");
  const isVerification = Boolean(
    onVerificationUrl || textHint || (inputProbe && submitProbe)
  );

  return {
    isVerification,
    onVerificationUrl,
    textHint,
    url,
    title
  };
}

async function clickTwoFactorSuccessOk(page, timeoutMs = 20000) {
  let currentUrl = page.url();
  if (!isTwoFactorSuccessUrl(currentUrl)) {
    return false;
  }

  let clicked = false;

  const okProbe = await waitForAnySelector(page, TWO_FACTOR_OK_SELECTORS, {
    visible: true,
    timeout: 8000
  });

  if (okProbe?.element) {
    console.log(`[2FA] Success page detected, clicking OK (${okProbe.selector})...`);
    clicked = true;
    await Promise.all([
      page
        .waitForNavigation({
          waitUntil: "networkidle2",
          timeout: Math.max(5000, Math.min(timeoutMs, 15000))
        })
        .catch(() => null),
      okProbe.element.click().catch(() => null)
    ]);
  } else {
    clicked = await page
      .evaluate(() => {
        const normalize = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const candidates = Array.from(
          document.querySelectorAll("button, input[type='button'], input[type='submit'], [role='button']")
        );
        const okButton = candidates.find((node) => {
          const id = normalize(node.id);
          const text = normalize(node.textContent || node.value || "");
          return id === "successful-device-verification" || text === "ok";
        });
        if (!okButton) return false;
        okButton.click();
        return true;
      })
      .catch(() => false);

    if (clicked) {
      await Promise.race([
        page
          .waitForNavigation({
            waitUntil: "networkidle2",
            timeout: Math.max(5000, Math.min(timeoutMs, 15000))
          })
          .catch(() => null),
        page
          .waitForFunction(() => window.location.href.includes("/users/posts/list"), {
            timeout: timeoutMs
          })
          .catch(() => null)
      ]);
    }
  }

  currentUrl = page.url();
  if (isPostsListUrl(currentUrl)) {
    return true;
  }

  if (isTwoFactorSuccessUrl(currentUrl)) {
    console.log("[2FA] Success page persisted, navigating to posts list directly...");
    await page
      .goto(POSTS_LIST_URL, {
        waitUntil: "networkidle2",
        timeout: timeoutMs
      })
      .catch(() => null);
    currentUrl = page.url();
  }

  return isPostsListUrl(currentUrl);
}

async function handleAgeGate(page, account) {
  const safeEmail = safeFilePart(account.email);
  const gatePresent = await page.evaluate(() => {
    const gate = document.querySelector("#ageCheckPopupDiv");
    if (!gate) return false;
    const style = window.getComputedStyle(gate);
    const rect = gate.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  });
  if (!gatePresent) return { gateHandled: false, checkboxChecked: false };

  console.log("Gate detected");
  await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-gate-before.png`), fullPage: true });

  const scrollMetrics = await page.evaluate(async () => {
    const container = document.querySelector("#ageCheckPopupInner .terms-container");
    if (!container) throw new Error("Terms container not found");
    while (container.scrollTop + container.clientHeight < container.scrollHeight - 5) {
      container.scrollTop += 250;
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    return { scrollTop: container.scrollTop, clientHeight: container.clientHeight, scrollHeight: container.scrollHeight };
  });
  console.log("Scrolled terms");

  await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-gate-after-scroll.png`), fullPage: true });
  await page.waitForSelector("#checkbox-agree", { visible: true });
  await page.click("#checkbox-agree");
  const checked = await page.$eval("#checkbox-agree", (el) => el.checked);
  if (!checked) throw new Error("checkbox-agree not checked after click");
  console.log("Checkbox checked: true");

  await page.waitForSelector("#ageagree", { visible: true });
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2", timeout: 25000 }).catch(() => null), page.click("#ageagree")]);
  console.log("Clicked I Agree");

  await page.waitForFunction(() => location.pathname.includes("/home") || location.pathname !== "/", { timeout: 25000 });
  const finalUrl = page.url();
  const title = await page.title();
  console.log(`Redirected to ${finalUrl}`);

  await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-after-agree.png`), fullPage: true });
  await fs.promises.writeFile(path.join(LOGS_DIR, `${safeEmail}-after-agree.json`), JSON.stringify({ email: account.email, timestamp: new Date().toISOString(), finalUrl, title, checkboxChecked: true }, null, 2), "utf8");
  return { gateHandled: true, checkboxChecked: true, finalUrl, title };
}

async function clickVerificationOkIfVisible(page, verificationConfig) {
  const okSelector = verificationConfig.VERIFICATION_OK_SELECTOR;
  try {
    const okButton = await page.$(okSelector);
    if (okButton) { await okButton.click(); await sleep(randomDelay(250, 500)); return true; }
    const clickedByText = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"));
      const target = buttons.find((node) => /^(ok|i agree|agree)$/i.test((node.textContent || node.value || "").trim()));
      if (!target) return false;
      target.click();
      return true;
    });
    if (clickedByText) await sleep(randomDelay(250, 500));
    return Boolean(clickedByText);
  } catch { return false; }
}

async function handleBlockingPopups(page, safeEmail) {
  ensureLogsDir();
  let popupHandled = false;
  const dialogs = [];

  const dialogHandler = async (dialog) => {
    dialogs.push(dialog.message());
    try { await dialog.accept(); popupHandled = true; } catch {}
  };

  page.on("dialog", dialogHandler);
  await sleep(100);
  try { await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-popup-before.png`), fullPage: true }); } catch {}

  try {
    const htmlPopupHandled = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && !el.disabled && rect.width > 0 && rect.height > 0;
      };
      const candidates = Array.from(document.querySelectorAll("button, [role='button'], .close, .btn"));
      const target = candidates.find((el) => {
        const txt = (el.textContent || el.value || "").trim().toLowerCase();
        return isVisible(el) && (txt === "ok" || txt === "close");
      });
      if (!target) return false;
      target.click();
      return true;
    });
    if (htmlPopupHandled) popupHandled = true;
  } catch {}

  try { await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-popup-after.png`), fullPage: true }); } catch {}
  page.off("dialog", dialogHandler);
  console.log(popupHandled ? "Popup handled" : "No popup detected");
  return { popupHandled, dialogs };
}

async function isVerificationStepPresent(page, verificationConfig) {
  const currentUrl = page.url();
  if (currentUrl.includes("/users/device-verification/verify/")) return true;
  if (!verificationConfig.VERIFICATION_INPUT_SELECTOR || !verificationConfig.VERIFICATION_SUBMIT_SELECTOR) return false;
  const input = await page.$(verificationConfig.VERIFICATION_INPUT_SELECTOR);
  const submit = await page.$(verificationConfig.VERIFICATION_SUBMIT_SELECTOR);
  return Boolean(input && submit);
}

async function pauseForVerificationCode(page, account, verificationConfig) {
  ensureLogsDir();
  const accountId = account._id.toString();
  const safeEmail = safeFilePart(account.email);
  await handleBlockingPopups(page, safeEmail);
  const currentUrl = page.url();
  const screenshotFileName = `${safeEmail}-verification-required.png`;
  const screenshotPath = path.join(LOGS_DIR, screenshotFileName);
  const screenshotUrl = toPublicLogPath(screenshotFileName);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.promises.writeFile(path.join(LOGS_DIR, `${safeEmail}-verification-required.json`), JSON.stringify({ email: account.email, timestamp: new Date().toISOString(), url: currentUrl, screenshotUrl }, null, 2), "utf8");

  clearPendingVerificationSession(accountId);
  const expiryTimer = setTimeout(async () => {
    const session = pendingVerificationSessions.get(accountId);
    if (!session) return;
    try { await session.browser.close(); } catch {}
    clearPendingVerificationSession(accountId);
  }, VERIFICATION_SESSION_TTL_MS);

  pendingVerificationSessions.set(accountId, { accountId, email: account.email, browser: page.browser(), page, safeEmail, verificationConfig, currentUrl, screenshotUrl, expiryTimer });

  await Account.findByIdAndUpdate(accountId, { status: "awaiting_verification_code", verificationCurrentUrl: currentUrl, verificationScreenshotPath: screenshotUrl, verificationRequestedAt: new Date() });
  await updateStatus(accountId, "awaiting_verification_code");
  
  // Emit Socket.IO event to frontend
  try {
    if (global.io) {
      emitToUser(global.io, account.userId, "verification-required", {
        accountId: accountId,
        email: account.email,
        userId: String(account.userId || ""),
        timestamp: new Date().toISOString()
      });
      console.log("Ã°Å¸â€œÂ¡ Socket.IO: verification-required event emitted");
    }
  } catch (ioError) {
    console.log("Ã°Å¸â€œÂ¡ Socket.IO emit error:", ioError.message);
  }
  
  console.log("Verification required - awaiting code from dashboard");

  return { awaitingVerificationCode: true, currentUrl, screenshotUrl };
}

async function runManualCheckpointLogin(page, account) {
  const safeEmail = safeFilePart(account.email);
  ensureLogsDir();
  const loginConfig = getManualLoginConfig();
  const verificationConfig = getVerificationConfig();

  try {
    console.log("Home reached");
    await sleep(5000);
    await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-home-before-close.png`), fullPage: true });

    const closeButton = await page.$("#closeCityButton > img, #closeCityButton img");
    if (closeButton) {
      await closeButton.click();
      console.log("Closed location modal");
      await sleep(randomDelay(300, 800));
    }

    await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-home-after-close.png`), fullPage: true });

    await page.waitForSelector("#hookup_an_ad_image", { visible: true, timeout: 25000 });
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2", timeout: 25000 }).catch(() => null), page.click("#hookup_an_ad_image")]);
    await page.waitForFunction(() => location.pathname.includes("/users/auth/login"), { timeout: 25000 });
    console.log("Clicked POST NOW");
    console.log("Reached login");

    await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-login-page.png`), fullPage: true });
    await sleep(randomDelay(1500, 2500));

    if (!page.url().includes("/users/auth/login")) {
      await page.goto(loginConfig.LOGIN_URL, { waitUntil: "networkidle2", timeout: 90000 });
      await sleep(randomDelay(1000, 2000));
    }

    console.log("[LOGIN] Waiting for username/password fields");
    const userSelector = await waitForElementBySelectors(page, loginConfig.USER_SELECTOR, { timeout: 30000 });
    const passSelector = await waitForElementBySelectors(page, loginConfig.PASS_SELECTOR, { timeout: 30000 });

    await page.click(userSelector, { clickCount: 3 });
    await page.type(userSelector, account.email, { delay: 25 });
    await page.click(passSelector, { clickCount: 3 });
    await page.type(passSelector, account.password, { delay: 25 });
    console.log("Filled credentials");

    await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-login-filled.png`), fullPage: true });

    const clickedOk = await clickVerificationOkIfVisible(page, verificationConfig);
    if (clickedOk) console.log("Clicked verification warning OK");

    if (await isVerificationStepPresent(page, verificationConfig)) {
      const verificationResult = await pauseForVerificationCode(page, account, verificationConfig);
      return { awaitingVerificationCode: true, finalUrl: verificationResult.currentUrl, title: await page.title(), loginResult: "awaiting_verification_code" };
    }

    let captchaImg = await page.$(loginConfig.CAPTCHA_IMG_SELECTOR);
    if (!captchaImg) {
      captchaImg = await page.evaluateHandle(() => {
        const captchaInput = document.querySelector('input[placeholder*="Enter code"]') || document.querySelector("#captcha_code");
        if (!captchaInput) return null;
        const container = captchaInput.closest("div, form, section") || document.body;
        return container.querySelector('img[src*="/captchas/"]') || container.querySelector("img");
      });
      if (!captchaImg || !captchaImg.asElement()) captchaImg = null;
    }

    let captchaUrl = null;
    if (captchaImg) {
      const rawCaptchaSrc = await page.evaluate((el) => el.getAttribute("src") || "", captchaImg);
      captchaUrl = rawCaptchaSrc ? new URL(rawCaptchaSrc, page.url()).href : null;
    }

    if (captchaUrl) console.log("[CAPTCHA]", captchaUrl);
    else console.log("[CAPTCHA] Captcha image URL not found.");

    await fs.promises.writeFile(path.join(LOGS_DIR, `${safeEmail}-captcha.json`), JSON.stringify({ email: account.email, timestamp: new Date().toISOString(), captchaUrl }, null, 2), "utf8");
    await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-captcha.png`), fullPage: true });

    const accountId = account._id.toString();
    clearPendingCaptchaSession(accountId);
    const expiryTimer = setTimeout(async () => {
      const session = pendingCaptchaSessions.get(accountId);
      if (!session) return;
      try { await session.browser.close(); } catch {}
      clearPendingCaptchaSession(accountId);
    }, CAPTCHA_SESSION_TTL_MS);

    pendingCaptchaSessions.set(accountId, { accountId, email: account.email, browser: page.browser(), page, loginConfig, verificationConfig, safeEmail, expiryTimer });

    const autoSolveEnabled = process.env.TWOCAPTCHA_AUTO_SOLVE === 'true';
    if (autoSolveEnabled && isConfigured() && captchaUrl) {
      console.log('[CAPTCHA] Auto-solve enabled, attempting to solve...');
      await sleep(randomDelay(1000, 2000));

      let captchaBase64 = null;
      try {
        const captchaElement = await page.$('#captcha_image_itself');
        if (captchaElement) {
          const boundingBox = await captchaElement.boundingBox();
          if (boundingBox) {
            const captchaScreenshot = await page.screenshot({ encoding: 'base64', clip: { x: boundingBox.x, y: boundingBox.y, width: boundingBox.width, height: boundingBox.height } });
            if (captchaScreenshot) {
              captchaBase64 = `data:image/png;base64,${captchaScreenshot}`;
              console.log('[CAPTCHA] Captured base64: success');
            }
          }
        }
      } catch (base64Error) {
        console.log('[CAPTCHA] Base64 capture error:', base64Error.message);
      }

      try {
        let solvedCaptcha = captchaBase64 ? await solveCaptchaBase64(captchaBase64) : await solveCaptcha(captchaUrl);
        console.log('[CAPTCHA] Auto-solved:', solvedCaptcha);
        await sleep(randomDelay(500, 1000));

        const submitResult = await submitCaptchaForAccount(accountId, solvedCaptcha);
        if (submitResult.success) {
          console.log('[CAPTCHA] Auto-submit successful');
          return {
            success: true,
            finalUrl: submitResult.finalUrl || page.url(),
            title: submitResult.title || await page.title(),
            loginResult: submitResult.status,
            awaitingCaptcha: submitResult.status === "awaiting_captcha",
            awaitingVerificationCode: submitResult.status === "awaiting_verification_code",
            autoSolved: true
          };
        } else if (submitResult.retryable) {
          console.log('[CAPTCHA] Auto-submit failed:', submitResult.message);
          return { awaitingCaptcha: true, finalUrl: page.url(), title: await page.title(), loginResult: "awaiting_captcha", message: submitResult.message };
        }
      } catch (solveError) {
        console.error('[CAPTCHA] Auto-solve failed:', solveError.message);
      }
    }

    if (!isConfigured() || !captchaUrl) {
      await Account.findByIdAndUpdate(accountId, { status: "awaiting_captcha", captchaUrl, captchaRequestedAt: new Date() });
      await updateStatus(accountId, "awaiting_captcha");
      return { awaitingCaptcha: true, finalUrl: page.url(), title: await page.title(), loginResult: "awaiting_captcha" };
    }

    return { awaitingCaptcha: true, finalUrl: page.url(), title: await page.title(), loginResult: "awaiting_captcha" };
  } catch (error) {
    try {
      await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-login-error.png`), fullPage: true });
      await fs.promises.writeFile(path.join(LOGS_DIR, `${safeEmail}-login-error.json`), JSON.stringify({ email: account.email, url: page.url(), error: error.message }, null, 2), "utf8");
    } catch (logError) { console.error("[LOGIN] Failed to write login error:", logError.message); }
    throw error;
  }
}

async function runAccountBoot(accountId) {
  const id = String(accountId);
  let browser = null;
  let account = null;
  let browserIp = null;
  let finalUrl = null;
  let title = null;
  let userAgentUsed = null;
  let attemptedManualLogin = false;
  let keepBrowserOpen = false;
  let postLoginStatus = "active";
  let reachedPostsList = false;

  try {
    account = await Account.findById(id);
    if (!account) throw new Error("Account not found for boot run");

    await updateStatus(id, "starting");
    const launched = await launchBrowser(account);
    browser = launched.browser;
    const { page } = launched;

    if (account.userAgent) await page.setUserAgent(account.userAgent);

    await page.goto("https://api.ipify.org?format=json", { waitUntil: "networkidle2", timeout: 60000 });
    const ipBody = await page.evaluate(() => document.body.innerText);
    try { browserIp = JSON.parse(ipBody).ip || ipBody; } catch { browserIp = ipBody; }
    console.log("Proxy IP detected:", browserIp);

    const loadedCookies = await loadCookiesForAccount(page, account);
    if (loadedCookies) {
      const validCookies = await validateCookiesForAccount(page, account);
      if (validCookies) {
        const bannedResult = await handleBannedAccount(page, account, {
          proxyIp: browserIp
        });

        reachedPostsList = true;
        finalUrl = page.url();
        title = await getPageTitleSafe(page);
        userAgentUsed = await getUserAgentSafe(page);
        if (bannedResult.banned) {
          postLoginStatus = "banned";
          console.warn(`[LOGIN] Banned state detected after cookie restore for ${account.email}`);
        } else {
          postLoginStatus = "active";
          console.log(`[LOGIN] Cookie session valid for ${account.email}, skipping login`);
        }
      }
    }

    if (!reachedPostsList) {
      try { await page.goto(ROOT_URL, { waitUntil: "networkidle2", timeout: 90000 }); }
      catch { await page.goto(ROOT_URL, { waitUntil: "domcontentloaded", timeout: 90000 }); }

      try {
        await sleep(randomDelay(300, 800));
        await handleAgeGate(page, account);
      } catch (gateError) {
        console.error("18+ gate error:", gateError.message);
        try {
          const safeEmailForAgree = safeFilePart(account.email);
          ensureLogsDir();
          if (!page.isClosed()) {
            await page.screenshot({
              path: path.join(LOGS_DIR, `${safeEmailForAgree}-gate-error.png`),
              fullPage: true
            });
          }
        } catch {}
        throw gateError;
      }

      finalUrl = page.url();
      title = await getPageTitleSafe(page);
      userAgentUsed = await getUserAgentSafe(page);
      console.log("Navigated to:", finalUrl);

      attemptedManualLogin = true;
      const loginResult = await runManualCheckpointLogin(page, account);
      finalUrl = loginResult?.finalUrl || page.url();
      title = loginResult?.title || (await getPageTitleSafe(page));
      userAgentUsed = await getUserAgentSafe(page);
      reachedPostsList = String(finalUrl || "").includes("/users/posts/list");

      if (reachedPostsList) {
        const bannedResult = await handleBannedAccount(page, account, {
          proxyIp: browserIp
        });
        if (bannedResult.banned) {
          postLoginStatus = "banned";
          keepBrowserOpen = false;
        }
      }

      if (loginResult.awaitingCaptcha || loginResult.awaitingVerificationCode) {
        keepBrowserOpen = true;
      } else if (loginResult.loginResult === "login_failed") {
        postLoginStatus = "error";
      }

      if (
        reachedPostsList &&
        !keepBrowserOpen &&
        postLoginStatus !== "banned" &&
        !page.isClosed()
      ) {
        await saveCookiesForAccount(page, account).catch((saveError) => {
          console.warn(`[COOKIES] Failed saving cookies for ${account.email}: ${saveError.message}`);
        });
      }
    }

    ensureLogsDir();
    const safeEmail = safeFilePart(account.email);
    if (!page.isClosed()) {
      await page
        .screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-boot.png`), fullPage: true })
        .catch(() => null);
    }
    await writeBootLog(safeEmail, {
      timestamp: new Date().toISOString(),
      accountId: id,
      email: account.email,
      proxyHost: account.proxyHost || null,
      proxyPort: account.proxyPort || null,
      browserIp,
      userAgentUsed,
      finalUrl,
      title
    });
    console.log("Boot verification complete");

    if (!keepBrowserOpen) {
      await updateStatus(id, postLoginStatus);
    }
  } catch (error) {
    try {
      const safeEmail = safeFilePart(account?.email || id);
      await writeBootLog(safeEmail, {
        timestamp: new Date().toISOString(),
        accountId: id,
        email: account?.email || null,
        error: error.message,
        stack: error.stack
      });
    } catch {}
    try {
      const latest = await Account.findById(id).select("status").lean();
      if (reachedPostsList || isSafeStatusForCatch(latest?.status)) {
        console.warn(
          `[BOOT] Suppressing error status for ${id} because session is already active`
        );
      } else {
        await updateStatus(id, "error");
      }
    } catch {}
  } finally {
    if (browser && !keepBrowserOpen) await browser.close();
  }
}

async function getCaptchaForAccount(accountId) {
  const account = await Account.findById(accountId);
  if (!account) throw new Error("Account not found");
  return { accountId: account._id.toString(), status: account.status, captchaUrl: account.captchaUrl || null };
}

async function refreshCaptchaForAccount(accountId) {
  const key = String(accountId);
  const session = pendingCaptchaSessions.get(key);
  if (!session) throw new Error("No active captcha session");

  const { page, loginConfig, safeEmail, email } = session;
  const captchaImage = await page.$("#captcha_image_itself, img[src*='captcha']");
  if (!captchaImage) throw new Error("Captcha image not found");

  await captchaImage.click().catch(() => null);
  await sleep(randomDelay(500, 900));

  const captchaUrl = await resolveCaptchaImageUrl(page, loginConfig);
  await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-captcha-refreshed.png`), fullPage: true });

  await Account.findByIdAndUpdate(key, { status: "awaiting_captcha", captchaUrl, captchaRequestedAt: new Date() });
  await updateStatus(key, "awaiting_captcha");
  return captchaUrl;
}

async function submitCaptchaForAccount(accountId, captchaText, maxRetries = 3) {
  const key = String(accountId);
  const session = pendingCaptchaSessions.get(key);
  if (!session) throw new Error("No active captcha session");
  if (!captchaText || !String(captchaText).trim()) throw new Error("captchaText is required");

  const { page, browser, loginConfig, verificationConfig, safeEmail, email } = session;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[CAPTCHA] Submit attempt ${attempt}/${maxRetries}`);
      
      const trimmedCaptcha = String(captchaText).trim();
      let captchaInput = await page.$(resolveCaptchaInputSelector(loginConfig));
      if (!captchaInput) captchaInput = await page.$("#captcha_code") || await page.$('input[name="captcha"]');
      if (!captchaInput) throw new Error("Captcha input not found");

      await captchaInput.click({ clickCount: 3 });
      await page.keyboard.type(trimmedCaptcha, { delay: 25 });
      
      // Verify the captcha was entered
      const enteredValue = await page.evaluate(el => el.value, captchaInput);
      console.log(`[CAPTCHA] Captcha entered: ${enteredValue}`);

      // Wait a moment for captcha validation
      await sleep(1000);

      // Use the comprehensive submit button finder
      await findAndClickSubmitButton(page, loginConfig.SUBMIT_SELECTOR);
      
      console.log("[CAPTCHA] Submit button clicked, waiting for navigation...");
      
      // Wait for navigation or URL change
      const preSubmitUrl = page.url();
      await Promise.race([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: CAPTCHA_SUBMIT_TIMEOUT_MS }),
        page.waitForFunction((oldUrl) => !window.location.href.includes('/login'), { timeout: CAPTCHA_SUBMIT_TIMEOUT_MS }).catch(() => null)
      ]).catch(() => null);
      
      await sleep(2000);

      const finalUrl = page.url();
      console.log(`[CAPTCHA] Response URL: ${finalUrl}`);
      
      // Check for bad_captcha in URL (wrong captcha)
      if (finalUrl.includes('bad_captcha') || finalUrl.includes('The%20Captcha')) {
        console.log(`Ã¢Å¡Â Ã¯Â¸Â [CAPTCHA] Wrong captcha detected (attempt ${attempt}/${maxRetries})`);
        
        if (attempt >= maxRetries) {
          await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-captcha-failed.png`), fullPage: true });
          throw new Error(`Captcha failed after ${maxRetries} attempts - wrong captcha`);
        }
        
        // Refresh captcha and retry
        console.log(`[CAPTCHA] Refreshing captcha and retrying...`);
        await refreshCaptchaForAccount(key);
        await sleep(1500);
        
        // Get new captcha for next attempt
        const newCaptchaImg = await page.$(loginConfig.CAPTCHA_IMG_SELECTOR);
        if (newCaptchaImg) {
          let newCaptchaUrl = await resolveCaptchaImageUrl(page, loginConfig);
          if (newCaptchaUrl) {
            // Solve new captcha
            let captchaBase64 = null;
            try {
              const boundingBox = await newCaptchaImg.boundingBox();
              if (boundingBox) {
                const screenshot = await page.screenshot({ encoding: 'base64', clip: { x: boundingBox.x, y: boundingBox.y, width: boundingBox.width, height: boundingBox.height } });
                if (screenshot) captchaBase64 = `data:image/png;base64,${screenshot}`;
              }
            } catch {}
            
            captchaText = captchaBase64 ? await solveCaptchaBase64(captchaBase64) : await solveCaptcha(newCaptchaUrl);
            console.log(`[CAPTCHA] New captcha solved: ${captchaText}`);
            continue; // Retry with new captcha
          }
        }
      }

      const title = await page.title();
      const failureReason = await detectCaptchaFailureReason(page);

      const stillOnLoginPage = /\/(login|signin)/i.test(new URL(finalUrl).pathname);
      if (stillOnLoginPage || failureReason) {
        if (attempt >= maxRetries) {
          const captchaUrl = await refreshCaptchaForAccount(key);
          return { success: false, status: "awaiting_captcha", retryable: true, reason: failureReason || "captcha_not_accepted", captchaUrl, message: failureReason === "wrong_captcha" ? "Wrong captcha" : "Captcha failed" };
        }
        // Retry
        console.log(`Ã¢Å¡Â Ã¯Â¸Â [CAPTCHA] Still on login page, retrying...`);
        await sleep(1500);
        continue;
      }

      const clickedOk = await clickVerificationOkIfVisible(page, verificationConfig || getVerificationConfig());
      if (clickedOk) console.log("Clicked verification OK");

      if (await isVerificationStepPresent(page, verificationConfig || getVerificationConfig())) {
        const account = await Account.findById(key);
        if (!account) throw new Error("Account not found");
        const verificationResult = await pauseForVerificationCode(page, account, verificationConfig || getVerificationConfig());
        clearPendingCaptchaSession(key);
        return { success: true, status: "awaiting_verification_code", currentUrl: verificationResult.currentUrl, screenshotUrl: verificationResult.screenshotUrl };
      }

      await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-after-captcha-submit.png`), fullPage: true });
      const accountForCookies =
        (await Account.findById(key).select("_id email proxyHost proxyPort").lean()) || {
          _id: key,
          email
        };

      const bannedResult = await handleBannedAccount(page, accountForCookies);
      if (bannedResult.banned) {
        clearPendingCaptchaSession(key);
        clearPendingVerificationSession(key);
        await browser.close().catch(() => null);
        return {
          success: false,
          status: "banned",
          message: "Account banned detected after login",
          finalUrl: page.url()
        };
      }

      await saveCookiesForAccount(page, accountForCookies).catch((saveError) => {
        console.warn(`[COOKIES] Failed to save cookies for ${email}: ${saveError.message}`);
      });

      await Account.findByIdAndUpdate(key, { status: "active", captchaUrl: null, captchaRequestedAt: null });
      await updateStatus(key, "active");
      clearPendingCaptchaSession(key);
      clearPendingVerificationSession(key);
      await browser.close();

      return { success: true, finalUrl, title, status: "active" };
    } catch (error) {
      console.error(`[CAPTCHA] Attempt ${attempt} failed:`, error.message);
      
      if (attempt >= maxRetries) {
        const reason = error.name === "TimeoutError" ? "timeout" : "submit_error";
        try { await page.screenshot({ path: path.join(LOGS_DIR, `${safeEmail}-login-error.png`), fullPage: true }); } catch {}
        return { success: false, status: "awaiting_captcha", retryable: true, reason, message: error.message };
      }
      
      // Wait before retry
      await sleep(2000);
    }
  }
  
  return { success: false, status: "awaiting_captcha", retryable: true, reason: "max_retries", message: "Max captcha retry attempts reached" };
}

async function getVerificationForAccount(accountId) {
  const account = await Account.findById(accountId);
  if (!account) throw new Error("Account not found");
  const screenshotUrl = account.verificationScreenshotPath || null;
  return { accountId: account._id.toString(), status: account.status, currentUrl: account.verificationCurrentUrl || null, screenshotUrl };
}

async function startBumpAutomation(page, account) {
  console.log(`[BUMP] Starting automation for ${account.email}`);

  let bumpCount = 0;
  const maxBumps = Number(account.maxDailyBumps || 10);

  while (bumpCount < maxBumps) {
    if (!page || page.isClosed()) {
      console.log(`[BUMP] Page closed for ${account.email}, stopping automation`);
      return;
    }

    try {
      console.log(`[BUMP] Cycle ${bumpCount + 1}/${maxBumps}`);

      const currentUrl = page.url();
      if (!currentUrl.includes("/users/posts/list")) {
        console.log("[BUMP] Navigating to posts list...");
        await page.goto("https://megapersonals.eu/users/posts/list", {
          waitUntil: "networkidle2",
          timeout: 30000
        });
      }

      const bannedResult = await handleBannedAccount(page, account);
      if (bannedResult.banned) {
        console.warn(`[BUMP] Stopping automation for banned account ${account.email}`);
        return;
      }

      console.log("[BUMP] Waiting 5 seconds...");
      await sleep(5000);

      console.log("[BUMP] Scrolling for 10 seconds...");
      const scrollDuration = 10000;
      const scrollStep = 500;
      const scrollAmount = 300;
      const scrollIntervals = Math.floor(scrollDuration / scrollStep);

      for (let i = 0; i < scrollIntervals; i += 1) {
        await page.evaluate((amount) => {
          window.scrollBy(0, amount);
        }, scrollAmount);
        await sleep(scrollStep);
      }

      console.log("[BUMP] Looking for Bump to Top button...");
      await page.waitForSelector("#managePublishAd", {
        visible: true,
        timeout: 10000
      });

      const bumpButton = await page.$("#managePublishAd");
      if (!bumpButton) {
        console.warn("[BUMP] Bump button not found, skipping this cycle");
        await sleep(60000);
        continue;
      }

      console.log("[BUMP] Clicking Bump to Top...");
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "networkidle2",
          timeout: 30000
        }),
        bumpButton.click()
      ]);

      const bumpPageUrl = page.url();
      console.log(`[BUMP] Redirected to: ${bumpPageUrl}`);

      console.log("[BUMP] Waiting 10 seconds on bump page...");
      await sleep(10000);

      console.log("[BUMP] Returning to posts list...");
      await page.goto("https://megapersonals.eu/users/posts/list", {
        waitUntil: "networkidle2",
        timeout: 30000
      });

      bumpCount += 1;
      console.log(`[BUMP] Bump ${bumpCount} completed`);

      await Account.findByIdAndUpdate(account._id, {
        status: "active",
        lastBumpAt: new Date(),
        totalBumpsToday: bumpCount
      });

      const randomDelayMs =
        (Number(account.baseInterval || 5) * 60 * 1000) +
        Math.floor(Math.random() * 2 * 60 * 1000);

      console.log(`[BUMP] Waiting ${Math.round(randomDelayMs / 60000)} minutes until next bump...`);
      await sleep(randomDelayMs);
    } catch (error) {
      console.error(`[BUMP] Error during cycle ${bumpCount + 1}:`, error.message);

      try {
        await page.screenshot({
          path: path.join(LOGS_DIR, `${safeFilePart(account.email)}-bump-error-${Date.now()}.png`),
          fullPage: true
        });
      } catch (screenshotError) {
        console.error("[BUMP] Failed to capture error screenshot:", screenshotError.message);
      }

      console.log("[BUMP] Waiting 2 minutes before retry...");
      await sleep(120000);
    }
  }

  console.log(`[BUMP] Daily bump limit reached (${maxBumps}) for ${account.email}`);
  await Account.findByIdAndUpdate(account._id, {
    status: "completed",
    lastBumpAt: new Date(),
    totalBumpsToday: bumpCount
  });
}

async function submitVerificationForAccount(accountId, code) {
  const key = String(accountId);
  const normalizedCode = String(code || "").trim();
  if (!/^\d{4}$/.test(normalizedCode)) {
    throw createTwoFactorError({
      status: 400,
      code: "2FA_CODE_INVALID",
      message: "Verification code must be exactly 4 digits"
    });
  }

  const account = await Account.findById(key);
  if (!account) {
    throw createTwoFactorError({
      status: 404,
      code: "2FA_ACCOUNT_NOT_FOUND",
      message: "Account not found"
    });
  }

  let session = pendingVerificationSessions.get(key);
  const browserConnected = Boolean(
    session?.browser &&
      typeof session.browser.isConnected === "function" &&
      session.browser.isConnected()
  );
  const pageReady = Boolean(session?.page && !session.page.isClosed());

  if (session && (!browserConnected || !pageReady)) {
    clearPendingVerificationSession(key);
    session = null;
  }

  const accountStatus = normalizeAccountStatus(account.status);
  if (!TWO_FACTOR_ALLOWED_STATUSES.has(accountStatus)) {
    const currentUrl = session?.page?.url?.() || account.verificationCurrentUrl || "";
    let currentTitle = "";
    if (session?.page && !session.page.isClosed()) {
      try {
        currentTitle = await session.page.title();
      } catch {}
    }

    throw createTwoFactorError({
      status: 409,
      code: "2FA_NOT_AWAITING",
      message: `Account not awaiting 2FA (current URL: ${currentUrl || "n/a"}, title: ${
        currentTitle || "n/a"
      })`,
      url: currentUrl,
      title: currentTitle,
      hint: "Wait until account status shows awaiting 2FA, then submit again."
    });
  }

  if (!session) {
    await Account.findByIdAndUpdate(key, {
      status: "2fa_failed",
      lastError: "Browser session missing before 2FA submit"
    });
    throw createTwoFactorError({
      status: 410,
      code: "2FA_SESSION_MISSING",
      message: "Browser session missing, restart required",
      hint: "Restart the account and request a new 2FA code prompt."
    });
  }

  const { page, email, safeEmail, verificationConfig } = session;

  try {
    const currentUrl = page.url();
    const currentTitle = await page.title().catch(() => "");
    console.log(
      `[2FA] Submitting code ${normalizedCode} for ${email} at ${currentUrl} (${currentTitle})`
    );

    const twoFactorState = await inspectTwoFactorPage(page);
    if (!twoFactorState.isVerification) {
      const diagnostics = await capture2FADiagnostics(
        page,
        key,
        email,
        "not-on-verification-page"
      );

      await Account.findByIdAndUpdate(key, {
        status: "2fa_failed",
        lastError: "Account was not on verification page during 2FA submit"
      });

      throw createTwoFactorError({
        status: 409,
        code: "2FA_NOT_AWAITING",
        message: `Account not awaiting 2FA (current URL: ${twoFactorState.url || "n/a"}, title: ${
          twoFactorState.title || "n/a"
        })`,
        url: twoFactorState.url,
        title: twoFactorState.title,
        diagnostics,
        hint: "Account session moved away from verification. Restart account and request code again."
      });
    }

    const inputResult = await waitForAnySelector(page, TWO_FACTOR_INPUT_SELECTORS, {
      visible: true,
      timeout: 15000
    });
    if (!inputResult?.element) {
      const diagnostics = await capture2FADiagnostics(
        page,
        key,
        email,
        "verification-input-missing"
      );

      throw createTwoFactorError({
        status: 409,
        code: "2FA_SELECTOR_NOT_FOUND",
        message: "Could not find the verification code input on the page.",
        url: twoFactorState.url,
        title: twoFactorState.title,
        diagnostics,
        hint: "The verification UI may not be loaded yet or selector changed. Retry submit."
      });
    }

    await inputResult.element.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await sleep(500);
    await inputResult.element.type(normalizedCode, { delay: 150 });

    console.log(
      `[2FA] Code entered with selector ${inputResult.selector}: ${normalizedCode}`
    );

    const submitResult = await waitForAnySelector(page, TWO_FACTOR_SUBMIT_SELECTORS, {
      visible: true,
      timeout: 10000
    });
    if (!submitResult?.element) {
      const diagnostics = await capture2FADiagnostics(
        page,
        key,
        email,
        "verification-submit-missing"
      );

      throw createTwoFactorError({
        status: 409,
        code: "2FA_SUBMIT_NOT_FOUND",
        message: "Could not find the verification submit button.",
        diagnostics,
        hint: "Page markup may have changed. Retry submit or restart account."
      });
    }

    let dialogAccepted = false;
    const dialogHandler = async (dialog) => {
      dialogAccepted = true;
      try {
        await dialog.accept();
      } catch {}
    };
    page.once("dialog", dialogHandler);

    console.log(`[2FA] Clicking PROCEED (${submitResult.selector})...`);
    await Promise.all([
      submitResult.element.click(),
      Promise.race([
        page
          .waitForNavigation({
            waitUntil: "networkidle2",
            timeout: TWO_FACTOR_TIMEOUT_MS
          })
          .catch(() => null),
        page
          .waitForFunction(
            () => window.location.href.includes("/users/posts/list"),
            { timeout: TWO_FACTOR_TIMEOUT_MS }
          )
          .catch(() => null)
      ])
    ]);

    const okButton = await waitForAnySelector(page, TWO_FACTOR_OK_SELECTORS, {
      visible: true,
      timeout: 8000
    });
    if (okButton?.element) {
      await Promise.all([
        page
          .waitForNavigation({
            waitUntil: "networkidle2",
            timeout: 12000
          })
          .catch(() => null),
        okButton.element.click().catch(() => null)
      ]);
    } else if (!dialogAccepted) {
      const clickedFallbackOk = await clickVerificationOkIfVisible(
        page,
        verificationConfig
      ).catch(() => false);
      if (clickedFallbackOk) {
        await Promise.race([
          page
            .waitForNavigation({
              waitUntil: "networkidle2",
              timeout: 12000
            })
            .catch(() => null),
          page
            .waitForFunction(
              () => window.location.href.includes("/users/posts/list"),
              { timeout: 12000 }
            )
            .catch(() => null)
        ]).catch(() => null);
      }
    }

    let finalUrl = page.url();
    console.log(`[2FA] Redirected to: ${finalUrl}`);

    if (isTwoFactorSuccessUrl(finalUrl)) {
      const reachedPostsList = await clickTwoFactorSuccessOk(page, TWO_FACTOR_TIMEOUT_MS);
      finalUrl = page.url();
      console.log(`[2FA] After success-page handling: ${finalUrl}`);
      if (!reachedPostsList && isTwoFactorSuccessUrl(finalUrl)) {
        await page
          .goto(POSTS_LIST_URL, {
            waitUntil: "networkidle2",
            timeout: TWO_FACTOR_TIMEOUT_MS
          })
          .catch(() => null);
        finalUrl = page.url();
      }
    }

    if (!isPostsListUrl(finalUrl)) {
      const diagnostics = await capture2FADiagnostics(
        page,
        key,
        email,
        "verification-no-redirect"
      );
      throw createTwoFactorError({
        status: 409,
        code: "2FA_SUBMIT_NO_REDIRECT",
        message: `2FA submitted but no success redirect detected (current URL: ${finalUrl})`,
        url: finalUrl,
        title: await page.title().catch(() => ""),
        diagnostics,
        hint: "Check the screenshot/HTML diagnostics to verify page state."
      });
    }

    const bannedResult = await handleBannedAccount(page, account);
    if (bannedResult.banned) {
      clearPendingVerificationSession(key);
      try {
        const activeBrowser = page.browser();
        if (activeBrowser?.isConnected?.()) {
          await activeBrowser.close();
        }
      } catch {}
      return {
        success: false,
        status: "banned",
        message: "Account banned detected after 2FA verification",
        finalUrl: page.url()
      };
    }

    await sleep(3000);
    await saveCookiesForAccount(page, account).catch((saveError) => {
      console.warn(`[COOKIES] Failed to save cookies after 2FA for ${email}: ${saveError.message}`);
    });

    ensureLogsDir();
    try {
      await page.screenshot({
        path: path.join(LOGS_DIR, `${safeEmail}-after-2fa.png`),
        fullPage: true
      });
      await fs.promises.writeFile(
        path.join(LOGS_DIR, `${safeEmail}-after-2fa.json`),
        JSON.stringify({ email, timestamp: new Date().toISOString(), finalUrl }, null, 2),
        "utf8"
      );
    } catch (logError) {
      console.error("[2FA] Post-submit log write failed:", logError.message);
    }

    await Account.findByIdAndUpdate(key, {
      status: "active",
      lastLoginAt: new Date(),
      verificationCompletedAt: new Date(),
      verificationCurrentUrl: null,
      verificationScreenshotPath: null,
      verificationRequestedAt: null
    });
    await updateStatus(key, "active");
    clearPendingVerificationSession(key);

    console.log("[AUTOMATION] Starting bump automation...");
    const automationAccount = (await Account.findById(key)) || { _id: key, email };
    startBumpAutomation(page, automationAccount).catch((automationError) => {
      console.error(`[BUMP] Automation stopped for ${email}:`, automationError.message);
    });

    return {
      success: true,
      status: "active",
      message: "2FA verification completed successfully",
      finalUrl
    };
  } catch (error) {
    console.error(`[2FA] Error for ${email}:`, error.message);

    if (error?.payload) {
      throw error;
    }

    const diagnostics = await capture2FADiagnostics(
      page,
      key,
      email,
      "verification-unhandled-error"
    );

    throw createTwoFactorError({
      status: 500,
      code: "2FA_SUBMIT_FAILED",
      message: error.message || "2FA submission failed",
      url: page.url(),
      title: await page.title().catch(() => ""),
      diagnostics
    });
  }
}

async function getTwoFactorForAccount(accountId) {
  return getVerificationForAccount(accountId);
}

async function submitTwoFactorForAccount(accountId, code) {
  return submitVerificationForAccount(accountId, code);
}

function inferBrowserEngineErrorType(message) {
  const text = String(message || "").toLowerCase();

  if (!text) return "unknown";
  if (text.includes("proxy")) return "proxy_failed";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("login") || text.includes("captcha")) return "login_failed";
  return "unknown";
}

function withStructuredEngineError(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error?.payload) {
        throw error;
      }

      const message = String(error?.message || "Browser engine error");
      const type =
        typeof error?.type === "string" && error.type
          ? error.type
          : inferBrowserEngineErrorType(message);

      if (error instanceof Error) {
        error.type = type;
        throw error;
      }

      const wrapped = new Error(message);
      wrapped.type = type;
      wrapped.originalError = error;
      throw wrapped;
    }
  };
}

module.exports = {
  runAccountBoot: withStructuredEngineError(runAccountBoot),
  getCaptchaForAccount: withStructuredEngineError(getCaptchaForAccount),
  refreshCaptchaForAccount: withStructuredEngineError(refreshCaptchaForAccount),
  submitCaptchaForAccount: withStructuredEngineError(submitCaptchaForAccount),
  getVerificationForAccount: withStructuredEngineError(getVerificationForAccount),
  submitVerificationForAccount: withStructuredEngineError(submitVerificationForAccount),
  getTwoFactorForAccount: withStructuredEngineError(getTwoFactorForAccount),
  submitTwoFactorForAccount: withStructuredEngineError(submitTwoFactorForAccount)
};

