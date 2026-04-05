const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const logger = require("./utils/logger");
const { initDatabase, closeDatabase } = require("./database/db");
const { startWhatsAppClient, closeWhatsAppClient, setWhatsAppDisabled } = require("./whatsapp/whatsappClient");
const { runSyncAndQueueCycle, scheduleDailyRun } = require("./scheduler/cronJobs");
const { startMessageWorker, stopMessageWorker, processQueueOnce } = require("./worker/messageWorker");
const { startApiServer } = require("./api/server");
const { getLatestSessionInfo, isSessionBlobHealthy } = require("./services/sessionService");

function envBool(name, defaultValue) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw);
}

/**
 * Validate required environment variables before starting any services.
 * Fail fast with clear error messages.
 */
function validateEnv() {
  const required = [
    "DATABASE_URL",
    "CRON_SCHEDULE",
    "APP_TIMEZONE",
    "JWT_SECRET",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  // Google service account: JSON string env var takes priority over file path
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT must be set.");
  }

  // If using file path, verify the file exists
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_SERVICE_ACCOUNT) {
    const saPath = path.resolve(process.cwd(), process.env.GOOGLE_SERVICE_ACCOUNT);
    if (!fs.existsSync(saPath)) {
      throw new Error(`Service account file not found: ${saPath}`);
    }
  }

  // Validate SHEET_ID or SHEET_URL present
  if (!process.env.SHEET_ID && !process.env.SHEET_URL) {
    throw new Error("Either SHEET_ID or SHEET_URL must be set in .env");
  }

  if (!process.env.ADMIN_API_KEY) {
    // No longer required — JWT auth is used instead
  }
}

let apiServer;
let cronTask;

async function ensureSeedAdmin() {
  const email = String(process.env.ADMIN_SEED_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_SEED_PASSWORD || "");
  if (!email || !password) return;

  const { query } = require("./database/db");
  const existing = await query("SELECT id FROM admins WHERE username = $1 LIMIT 1", [email]);
  if (existing.rows.length) return;

  const hash = await bcrypt.hash(password, 12);
  await query(
    "INSERT INTO admins (username, password_hash) VALUES ($1, $2)",
    [email, hash]
  );
  logger.info("Seed admin created.", { email });
}

async function start() {
  validateEnv();
  await initDatabase();
  await ensureSeedAdmin();

  const enableWhatsApp = envBool("ENABLE_WHATSAPP", true);
  const enableWorker = envBool("ENABLE_WORKER", true);
  const enableScheduler = envBool("ENABLE_SCHEDULER", true);

  setWhatsAppDisabled(!enableWhatsApp);

  if (enableWhatsApp) {
    await startWhatsAppClient();
  } else {
    logger.info("WhatsApp client disabled by config.", { ENABLE_WHATSAPP: false });
  }

  if (enableWhatsApp) {
    const session = await getLatestSessionInfo();
    if (session && !isSessionBlobHealthy(session)) {
      logger.warn("Persisted WhatsApp session payload looks too small; restore may fail on restart.", {
        session_name: session.session_name,
        bytes: session.bytes,
        updated_at: session.updated_at,
      });
    }
  }

  if (enableWorker) {
    startMessageWorker();
  } else {
    logger.info("Queue worker disabled by config.", { ENABLE_WORKER: false });
  }

  if (enableScheduler) {
    cronTask = scheduleDailyRun();
  } else {
    logger.info("Scheduler disabled by config.", { ENABLE_SCHEDULER: false });
  }

  apiServer = startApiServer();

  if (process.argv.includes("--run-now")) {
    await runSyncAndQueueCycle();
    if (enableWorker) {
      await processQueueOnce();
    }
    await shutdown(0);
    return;
  }

  logger.info("Automation backend is running.");

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

async function shutdown(exitCode) {
  logger.info("Shutting down service...");

  // Force-exit after 30 seconds if graceful shutdown hangs
  const forceTimer = setTimeout(() => {
    logger.error("Graceful shutdown timed out after 30s, forcing exit.");
    process.exit(exitCode || 1);
  }, 30000);
  forceTimer.unref();

  try {
    if (cronTask) cronTask.stop();
    await stopMessageWorker();
    if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
    await closeWhatsAppClient();
    await closeDatabase();
  } catch (err) {
    logger.error("Error during shutdown.", { error: err.message });
  }

  clearTimeout(forceTimer);
  process.exit(exitCode);
}

start().catch(async (error) => {
  logger.error("Startup failed.", { error: error.message });
  try {
    await shutdown(1);
  } catch {
    process.exit(1);
  }
});
