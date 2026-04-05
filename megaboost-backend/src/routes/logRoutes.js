const express = require("express");
const router = express.Router();

const logController = require("../controller/logController");

// Create log
router.post("/", logController.createLog);

// Recent logs for dashboard
router.get("/recent", logController.getRecentLogs);

// Get logs (paged + filter/search + stats)
router.get("/", logController.getLogsPaged);

// Get stats
router.get("/stats", logController.getLogStats);

router.get("/analytics", logController.getLogAnalytics);

// Log analytics aggregation endpoints
router.get("/source-ips", logController.getSourceIps);
router.get("/affected-accounts", logController.getAffectedAccounts);
router.get("/export", logController.exportLogs);

module.exports = router;
