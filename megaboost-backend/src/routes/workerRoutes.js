const express = require("express");
const router = express.Router();

const {
  getWorkersStatus,
  getWorkerDebug
} = require("../controller/accountController");

router.get("/status", getWorkersStatus);
router.get("/debug/:accountId", getWorkerDebug);

module.exports = router;
