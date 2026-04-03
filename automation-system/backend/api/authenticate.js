const jwt = require("jsonwebtoken");

const COOKIE_NAME = "admin_token";

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET env var is not set.");
  return secret;
}

/**
 * Express middleware: verifies the admin_token cookie.
 * HTML requests are redirected to /login; API and asset requests get a 401 JSON response.
 */
function authenticate(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) {
    const isApiOrAsset =
      req.path.startsWith("/admin/api") ||
      req.path.startsWith("/admin/qr") ||
      req.path.startsWith("/admin/assets");
    if (isApiOrAsset) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    return res.redirect("/login");
  }

  try {
    req.admin = jwt.verify(token, getJwtSecret());
    next();
  } catch {
    const isApiOrAsset =
      req.path.startsWith("/admin/api") ||
      req.path.startsWith("/admin/qr") ||
      req.path.startsWith("/admin/assets");
    if (isApiOrAsset) {
      return res.status(401).json({ ok: false, error: "Session expired. Please log in again." });
    }
    return res.redirect("/login");
  }
}

module.exports = { authenticate, getJwtSecret, COOKIE_NAME };
