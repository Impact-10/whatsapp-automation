const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const QRCode = require("qrcode");
const logger = require("../utils/logger");
const { getQueueCounts } = require("../services/queueService");
const { query } = require("../database/db");
const { getDashboardSummary, getRecentLogs, markVisited, getAllReminders, updateFrequency, getVisitHistory, deleteReminder } = require("../services/reminderService");
const { runSyncAndQueueCycle } = require("../scheduler/cronJobs");
const { processQueueOnce } = require("../worker/messageWorker");
const {
  getWhatsAppStatus,
  reconnectWhatsAppSession,
  getLatestQr,
} = require("../whatsapp/whatsappClient");
const { getLatestSessionInfo, isSessionBlobHealthy } = require("../services/sessionService");
const { getMessageTemplate, setMessageTemplate, getSetting, setSetting } = require("../services/settingsService");
const { listSheetRows, appendSheetRow, deleteSheetRow } = require("../services/sheetsService");
const { authenticate } = require("./authenticate");
const authRoutes = require("./authRoutes");

function startApiServer() {
  const app = express();

  // Trust proxy for correct IP detection behind Render/nginx
  app.set("trust proxy", 1);

  app.use(express.json());
  app.use(cookieParser());

  // CORS — same origin by default; expand via CORS_ORIGIN env if needed
  app.use(cors({
    origin: process.env.CORS_ORIGIN || false,
    credentials: true,
  }));

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'"
    );
    next();
  });

  // Rate limit for auth endpoints (strict)
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: "Too many attempts. Try again in 15 minutes." },
  });

  // General rate limit for admin API
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: "Rate limit exceeded. Slow down." },
  });

  const wrap = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

  // ── Public routes ──────────────────────────────────────────────────────────

  app.get("/health", wrap(async (_req, res) => {
    const [queue, whatsapp, db] = await Promise.all([
      getQueueCounts(),
      Promise.resolve(getWhatsAppStatus()),
      query("SELECT 1 AS ok")
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: error.message })),
    ]);

    return res.json({
      ok: db.ok,
      queue,
      whatsapp,
      database: db,
      timestamp: new Date().toISOString(),
    });
  }));

  // Auth routes: /auth/status, /auth/setup, /auth/login, /auth/logout
  app.use("/auth", authLimiter, authRoutes);

  // Login page
  app.get("/login", (_req, res) => {
    res.sendFile(path.join(__dirname, "../public/login.html"));
  });

  // Redirect root to dashboard
  app.get("/", (_req, res) => res.redirect("/admin"));

  // ── Protected /admin routes ────────────────────────────────────────────────

  app.use("/admin", authenticate);

  // Serve static assets
  app.use("/admin/assets", express.static(path.join(__dirname, "../public")));

  // Dashboard SPA
  app.get("/admin", (_req, res) => {
    res.sendFile(path.join(__dirname, "../public/dashboard.html"));
  });

  // All /admin/api and other /admin endpoints use API rate limit
  app.use("/admin", apiLimiter);

  app.get("/admin/qr", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    return res.json({ qr: getLatestQr() });
  });

  app.get("/admin/qr/svg", wrap(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    const qr = getLatestQr();
    if (!qr) {
      return res.status(404).json({ ok: false, message: "QR not available. WhatsApp may already be connected." });
    }
    const svg = await QRCode.toString(qr, { type: "svg", margin: 1, width: 320 });
    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(svg);
  }));

  app.get("/admin/api/full-status", wrap(async (_req, res) => {
    const [queue, dashboard, whatsapp, session, logs] = await Promise.all([
      getQueueCounts(),
      getDashboardSummary(),
      Promise.resolve(getWhatsAppStatus()),
      getLatestSessionInfo(),
      getRecentLogs(30),
    ]);
    return res.json({
      queue,
      dashboard,
      whatsapp,
      session: { ...session, healthy: isSessionBlobHealthy(session) },
      logs,
    });
  }));

  // All reminders with full detail (for Records + Visits tabs)
  app.get("/admin/api/reminders", wrap(async (_req, res) => {
    const reminders = await getAllReminders();
    return res.json({ ok: true, reminders });
  }));

  // Update frequency for a reminder (recalculates next_due_date)
  app.patch("/admin/api/reminders/:id/frequency", wrap(async (req, res) => {
    const id = Number(req.params.id);
    const freq = Number(req.body?.frequencyDays);
    if (!id || isNaN(id)) return res.status(400).json({ ok: false, error: "Invalid reminder ID" });
    if (!freq || freq < 1 || isNaN(freq)) return res.status(400).json({ ok: false, error: "frequencyDays must be >= 1" });
    const row = await updateFrequency(id, freq);
    if (!row) return res.status(404).json({ ok: false, error: "Reminder not found" });
    return res.json({ ok: true, ...row });
  }));

  app.post("/admin/api/reminders/:id/mark-visited", wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ ok: false, error: "Invalid reminder ID" });
    const row = await markVisited(id);
    if (!row) return res.status(404).json({ ok: false, error: "Reminder not found" });
    return res.json({ ok: true, ...row });
  }));

  app.get("/admin/api/reminders/:id/history", wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ ok: false, error: "Invalid reminder ID" });
    const visits = await getVisitHistory(id);
    return res.json({ ok: true, visits });
  }));

  app.delete("/admin/api/reminders/:id", wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ ok: false, error: "Invalid reminder ID" });
    const result = await deleteReminder(id);
    if (!result) return res.status(404).json({ ok: false, error: "Reminder not found" });
    return res.json({ ok: true });
  }));

  // Settings endpoints for follow-up config
  app.get("/admin/api/settings/:key", wrap(async (req, res) => {
    const value = await getSetting(req.params.key);
    return res.json({ ok: true, key: req.params.key, value });
  }));

  app.post("/admin/api/settings/:key", wrap(async (req, res) => {
    const value = String(req.body?.value || "");
    if (!value.trim()) return res.status(400).json({ ok: false, error: "Value cannot be empty." });
    const saved = await setSetting(req.params.key, value);
    return res.json({ ok: true, value: saved });
  }));

  app.get("/admin/api/settings/message-template", wrap(async (_req, res) => {
    const value = await getMessageTemplate();
    return res.json({ ok: true, value });
  }));

  app.post("/admin/api/settings/message-template", wrap(async (req, res) => {
    const value = String(req.body?.value || "");
    if (!value.trim()) {
      return res.status(400).json({ ok: false, error: "Template cannot be empty." });
    }
    const saved = await setMessageTemplate(value);
    return res.json({ ok: true, value: saved });
  }));

  app.get("/admin/api/sheet", wrap(async (_req, res) => {
    const data = await listSheetRows();
    return res.json({ ok: true, ...data });
  }));

  app.post("/admin/api/sheet", wrap(async (req, res) => {
    const payload = req.body || {};
    const required = ["ownerName", "phone", "petName", "vaccine", "firstVisitDate"];
    const missing = required.filter((k) => !String(payload[k] || "").trim());
    if (missing.length) {
      return res.status(400).json({ ok: false, error: `Missing fields: ${missing.join(", ")}` });
    }
    await appendSheetRow(payload);
    return res.json({ ok: true });
  }));

  app.delete("/admin/api/sheet/:rowNumber", wrap(async (req, res) => {
    const rowNumber = Number(req.params.rowNumber);
    if (!rowNumber || isNaN(rowNumber)) {
      return res.status(400).json({ ok: false, error: "Invalid row number." });
    }
    await deleteSheetRow(rowNumber);
    return res.json({ ok: true });
  }));

  app.post("/admin/reconnect", wrap(async (_req, res) => {
    const result = await reconnectWhatsAppSession();
    return res.json(result);
  }));

  app.post("/admin/run-now", wrap(async (_req, res) => {
    const pipeline = await runSyncAndQueueCycle();
    await processQueueOnce();
    return res.json({ ok: true, pipeline });
  }));

  app.get("/admin/status", wrap(async (_req, res) => {
    const queue = await getQueueCounts();
    const dashboard = await getDashboardSummary();
    const whatsapp = getWhatsAppStatus();
    return res.json({ queue, dashboard, whatsapp });
  }));

  app.get("/admin/session-check", wrap(async (_req, res) => {
    const session = await getLatestSessionInfo();
    return res.json({
      session,
      healthy: isSessionBlobHealthy(session),
      message: session
        ? "Session row found. healthy=true usually indicates restore-ready payload."
        : "No session row found yet. Scan and wait for backup sync.",
    });
  }));

  app.use((error, _req, res, _next) => {
    logger.error("API request failed.", { error: error.message, stack: error.stack });
    res.status(500).json({ ok: false, error: error.message });
  });

  const port = Number(process.env.API_PORT || 3000);
  const server = app.listen(port, () => {
    logger.info("API server started.", { port });
  });

  return server;
}

module.exports = {
  startApiServer,
};
