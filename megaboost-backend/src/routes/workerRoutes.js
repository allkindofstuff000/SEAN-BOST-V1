const express = require("express");
const router = express.Router();

const { getWorkersStatus } = require("../controller/accountController");

router.get("/status", getWorkersStatus);

module.exports = router;
