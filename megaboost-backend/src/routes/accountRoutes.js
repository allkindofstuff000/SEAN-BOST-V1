const express = require("express");
const router = express.Router();

const {
  addAccount,
  getAccounts,
  getAccountById,
  getCaptcha,
  submitCaptcha,
  refreshCaptcha,
  getVerification,
  submitVerification,
  getTwoFactor,
  submitTwoFactor,
  updateAccount,
  deleteAccount,
  startAccount,
  stopAccount,
  restartAccount,
  startAllAccounts,
  stopAllAccounts,
  testConnection,
  resetRetry
} = require("../controller/accountController");
const { requireAuth } = require("../middleware/requireAuth");
const { requireValidLicense } = require("../middleware/requireValidLicense");

router.use(requireAuth);

// Add account
router.post("/", requireValidLicense, addAccount);

// Get accounts
router.get("/", getAccounts);

// Start all eligible accounts (optionally restricted via body.accountIds[])
router.post("/start-all", requireValidLicense, startAllAccounts);

// Stop all running-like accounts (optionally restricted via body.accountIds[])
router.post("/stop-all", stopAllAccounts);

// Get account by id
router.get("/:id", getAccountById);

// Get captcha data for awaiting checkpoint
router.get("/:id/captcha", getCaptcha);

// Submit captcha text and resume login flow
router.post("/:id/captcha", submitCaptcha);

// Refresh captcha image while keeping the same browser session alive
router.post("/:id/captcha/refresh", refreshCaptcha);

// Get verification checkpoint data
router.get("/:id/verification", getVerification);

// Submit verification code and resume flow
router.post("/:id/verification", submitVerification);

// Get 2FA checkpoint data
router.get("/:id/2fa", getTwoFactor);

// Submit 2FA code and resume flow
router.post("/:id/2fa", submitTwoFactor);

// Update bump settings
router.put("/:id", requireValidLicense, updateAccount);

// Delete account
router.delete("/:id", deleteAccount);

// Start account
router.post("/:id/start", requireValidLicense, startAccount);

// Stop account
router.post("/:id/stop", stopAccount);

// Restart account
router.post("/:id/restart", requireValidLicense, restartAccount);

// Reset worker retry/circuit-breaker state
router.post("/:id/reset-retry", resetRetry);

// Test account proxy + navigation
router.post("/:id/test-connection", testConnection);

module.exports = router;
