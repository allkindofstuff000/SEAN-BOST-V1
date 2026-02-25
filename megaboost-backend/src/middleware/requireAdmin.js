function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Authentication required"
    });
  }

  if (String(req.user.role || "").toLowerCase() !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Admin access required"
    });
  }

  return next();
}

module.exports = {
  requireAdmin
};
