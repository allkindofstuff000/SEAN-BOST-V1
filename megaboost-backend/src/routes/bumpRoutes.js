const express = require("express");
const router = express.Router();

const {
  getQuickPresets,
  applyQuickPreset
} = require("../controller/bumpController");
const { requireValidLicense } = require("../middleware/requireValidLicense");

router.get("/presets", getQuickPresets);
router.post("/presets/apply", requireValidLicense, applyQuickPreset);

module.exports = router;
