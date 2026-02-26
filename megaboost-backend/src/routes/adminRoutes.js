const express = require("express");
const {
  getAdminOverview,
  createLicense,
  listLicenses,
  updateLicense,
  createUser,
  listUsers,
  updateUser
} = require("../controller/adminController");
const {
  getAdminTelegramSettings,
  updateAdminTelegramSettings
} = require("../controller/adminTelegramController");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get("/overview", getAdminOverview);
router.get("/telegram", getAdminTelegramSettings);
router.post("/telegram", updateAdminTelegramSettings);

router.post("/licenses", createLicense);
router.get("/licenses", listLicenses);
router.put("/licenses/:id", updateLicense);

router.post("/users", createUser);
router.get("/users", listUsers);
router.put("/users/:id", updateUser);

module.exports = router;

