const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { query } = require("../database/db");
const { getJwtSecret, COOKIE_NAME } = require("./authenticate");

const router = express.Router();

const TOKEN_EXPIRY = "8h";
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

async function countAdmins() {
  const { rows } = await query("SELECT COUNT(*) AS count FROM admins");
  return parseInt(rows[0].count, 10);
}

// GET /auth/status — used by login page to show setup guidance
router.get("/status", async (_req, res) => {
  const count = await countAdmins();
  return res.json({
    hasAdmins: count > 0,
    setupRequired: count === 0,
    message: count === 0
      ? "No admin found. Add an admin row in the admins table."
      : "Admin list is configured.",
  });
});

// POST /auth/login
router.post("/login", async (req, res) => {
  const { email, username, password } = req.body || {};
  const loginId = String(email || username || "").trim().toLowerCase();
  if (!loginId || !password) {
    return res.status(400).json({ ok: false, error: "Email and password are required." });
  }

  const { rows } = await query(
    "SELECT * FROM admins WHERE username = $1",
    [loginId]
  );
  if (!rows.length) {
    return res.status(401).json({ ok: false, error: "Invalid email or password." });
  }

  const admin = rows[0];
  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) {
    return res.status(401).json({ ok: false, error: "Invalid email or password." });
  }

  await query("UPDATE admins SET last_login = NOW() WHERE id = $1", [admin.id]);

  const token = jwt.sign(
    { id: admin.id, email: admin.username, username: admin.username },
    getJwtSecret(),
    { expiresIn: TOKEN_EXPIRY }
  );

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: COOKIE_MAX_AGE_MS,
  });

  return res.json({ ok: true });
});

// POST /auth/logout
router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  return res.json({ ok: true });
});

module.exports = router;
