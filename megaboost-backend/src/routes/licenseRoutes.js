const express = require("express");
const router = express.Router();

const { getLicenseLimits, getMyLicense } = require("../controller/licenseController");
const { requireAuth } = require("../middleware/requireAuth");

router.get("/me", requireAuth, getMyLicense);
router.get("/limits", requireAuth, getLicenseLimits);

module.exports = router;
