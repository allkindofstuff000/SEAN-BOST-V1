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


module.exports = router;
