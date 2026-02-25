const express = require("express");
const { login, logout, me } = require("../controller/authController");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();

router.post("/login", login);
router.post("/logout", logout);
router.get("/me", requireAuth, me);

module.exports = router;
