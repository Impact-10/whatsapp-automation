const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const qrcode = require("qrcode-terminal");
const { Client, RemoteAuth } = require("whatsapp-web.js");
const logger = require("../utils/logger");
const { query } = require("../database/db");
const { PostgresSessionStore } = require("./postgresSessionStore");

let clientInstance;
let latestQr;
let ready = false;
let reconnecting = false;
let statusMessage = "not_initialized";
let backupIntervalRef = null;
let initRecoveryAttempted = false;

// Prevent EBUSY or other unhandled rejections from crashing the process during session backup.
process.on("unhandledRejection", (reason) => {
  if (reason && reason.code === "EBUSY") {
    logger.warn("Suppressed EBUSY unhandled rejection during session backup.", { path: reason.path });
    return;
  }
  logger.error("Unhandled rejection.", { error: String(reason) });
});

/**
 * Recursively copy a directory, silently skipping any files that are locked (EBUSY/EPERM/EACCES).
 */
async function safeCopyDir(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) {
        await safeCopyDir(srcPath, destPath);
      } else {
        await fs.promises.copyFile(srcPath, destPath);
      }
    } catch (err) {
      if (["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE"].includes(err.code)) {
        // Skip locked/busy files — they are not needed for session restore.
        continue;
      }
      throw err;
    }
  }
}

function sessionNameFromClientId(clientId) {
  return clientId ? `RemoteAuth-${clientId}` : "RemoteAuth";
}

function createClient() {
  const store = new PostgresSessionStore({ queryFn: query });
  const dataPath = path.resolve(process.cwd(), process.env.WHATSAPP_SESSION_PATH || "./sessions");
  const clientId = process.env.WHATSAPP_CLIENT_ID || "default";

  // Ensure data directory exists in ephemeral container environments (Render, Docker, etc.)
  fs.mkdirSync(dataPath, { recursive: true });

  const authStrategy = new RemoteAuth({
    clientId,
    store,
    dataPath,
    backupSyncIntervalMs: Number(process.env.WHATSAPP_REMOTE_BACKUP_INTERVAL_MS || 300000),
  });

  const originalDeleteMetadata = authStrategy.deleteMetadata.bind(authStrategy);
  authStrategy.deleteMetadata = async function safeDeleteMetadata() {
    try {
      await originalDeleteMetadata();
    } catch (error) {
      if (error && error.code === "ENOENT") {
        logger.warn("RemoteAuth metadata cleanup skipped missing path.", {
          path: error.path,
        });
        return;
      }
      throw error;
    }
  };

  authStrategy.compressSession = async function safeCompressSession() {
    const tempDir = path.join(this.dataPath, `wwebjs_temp_session_${clientId}`);
    const zipPath = path.join(this.dataPath, `${this.sessionName}.zip`);

    // Step 1: Copy live session to temp dir, skipping any locked files.
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await safeCopyDir(this.userDataDir, tempDir);

    // Step 2: Strip non-essential dirs from the copy (caches, GPU, blobs, etc.)
    const keepDirs = new Set(["Default", "IndexedDB", "Local Storage"]);
    const tempEntries = await fs.promises.readdir(tempDir, { withFileTypes: true });
    for (const entry of tempEntries) {
      if (!keepDirs.has(entry.name)) {
        const fullPath = path.join(tempDir, entry.name);
        await fs.promises.rm(fullPath, { recursive: true, force: true }).catch(() => {});
      }
    }
    // Also strip caches inside Default/
    const defaultDir = path.join(tempDir, "Default");
    if (fs.existsSync(defaultDir)) {
      const defaultEntries = await fs.promises.readdir(defaultDir, { withFileTypes: true });
      for (const entry of defaultEntries) {
        if (!["IndexedDB", "Local Storage"].includes(entry.name) && entry.isDirectory()) {
          await fs.promises.rm(path.join(defaultDir, entry.name), { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    // Step 3: Archive the clean temp copy.
    const archive = archiver("zip", { zlib: { level: 9 } });
    const output = fs.createWriteStream(zipPath);
    await new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.directory(tempDir, false);
      archive.finalize();
    });

    // Step 4: Clean up temp dir.
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };

  // Override afterAuthReady so backup sync is wrapped in try/catch and never crashes the process.
  const originalStoreRemoteSession = authStrategy.storeRemoteSession.bind(authStrategy);
  authStrategy.afterAuthReady = async function safeAfterAuthReady() {
    // Clear any previous backup interval to prevent leaks on reconnect.
    if (backupIntervalRef) {
      clearInterval(backupIntervalRef);
      backupIntervalRef = null;
    }
    const sessionExists = await this.store.sessionExists({ session: this.sessionName });
    if (!sessionExists) {
      await this.delay(60000);
      try {
        await originalStoreRemoteSession({ emit: true });
      } catch (err) {
        logger.error("Initial session backup failed (will retry next interval).", { error: err.message });
      }
    }
    const self = this;
    this.backupSync = setInterval(async () => {
      try {
        await originalStoreRemoteSession();
      } catch (err) {
        logger.error("Periodic session backup failed (will retry next interval).", { error: err.message });
      }
    }, this.backupSyncIntervalMs);
    backupIntervalRef = this.backupSync;
  };

  const client = new Client({
    authStrategy,
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      headless: String(process.env.PUPPETEER_HEADLESS || "true") === "true",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
      ],
    },
  });

  client.on("qr", (qr) => {
    latestQr = qr;
    ready = false;
    statusMessage = "qr_required";
    logger.info("WhatsApp QR generated. Scan once to establish persistent session.");
    qrcode.generate(qr, { small: true });
  });

  client.on("authenticated", () => {
    statusMessage = "authenticated";
    logger.info("WhatsApp authenticated successfully.");
  });

  client.on("remote_session_saved", () => {
    statusMessage = "session_saved";
    logger.info("Remote WhatsApp session saved to PostgreSQL.");
  });

  client.on("ready", () => {
    latestQr = null;
    ready = true;
    reconnecting = false;
    initRecoveryAttempted = false;
    statusMessage = "ready";
    logger.info("WhatsApp client ready. Session restored or authenticated.");
  });

  client.on("auth_failure", (message) => {
    ready = false;
    statusMessage = `auth_failure:${message}`;
    logger.error("WhatsApp auth failure.", { message });
  });

  client.on("disconnected", (reason) => {
    ready = false;
    statusMessage = `disconnected:${reason}`;
    logger.warn("WhatsApp disconnected.", { reason });

    // Auto-reconnect: destroy current instance and re-initialize after a short delay.
    setTimeout(async () => {
      logger.info("Auto-reconnect: attempting to restore WhatsApp session...");
      try {
        if (clientInstance) {
          try { await clientInstance.destroy(); } catch { /* no-op */ }
          clientInstance = null;
        }
        ready = false;
        reconnecting = true;
        statusMessage = "auto_reconnecting";
        await startWhatsAppClient();
      } catch (err) {
        logger.error("Auto-reconnect failed.", { error: err.message });
        statusMessage = `auto_reconnect_failed:${err.message}`;
      } finally {
        reconnecting = false;
      }
    }, 5000);
  });

  return { client, dataPath, clientId };
}

async function startWhatsAppClient() {
  if (clientInstance) {
    return clientInstance;
  }

  const { client, dataPath, clientId } = createClient();
  clientInstance = client;
  statusMessage = "initializing";

  client.initialize().catch(async (error) => {
    ready = false;
    const message = String(error?.message || "");

    // One-time recovery for missing RemoteAuth zip path in fresh containers.
    if (
      !initRecoveryAttempted &&
      (error?.code === "ENOENT" || message.includes("RemoteAuth-") || message.includes(".zip"))
    ) {
      initRecoveryAttempted = true;
      statusMessage = "recovering_missing_session";
      logger.warn("WhatsApp init hit missing session artifact. Retrying with clean local auth cache.", {
        error: message,
      });

      try {
        await fs.promises.mkdir(dataPath, { recursive: true });
        const sessionName = sessionNameFromClientId(clientId);
        await fs.promises.rm(path.join(dataPath, `${sessionName}.zip`), { force: true });
      } catch {
        // no-op: recovery continues even if local cleanup has nothing to remove
      }

      if (clientInstance === client) {
        clientInstance = null;
      }

      setTimeout(() => {
        startWhatsAppClient().catch((retryError) => {
          logger.error("WhatsApp retry initialization failed.", { error: retryError.message });
        });
      }, 1500);

      return;
    }

    statusMessage = `init_error:${message}`;
    logger.error("WhatsApp initialization failed.", { error: error.message });
  });

  return clientInstance;
}

async function waitForWhatsAppReady(timeoutMs = 180000) {
  const start = Date.now();
  while (!ready && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!ready) {
    throw new Error("WhatsApp is not ready yet.");
  }
}

async function sendWhatsAppMessage(phone, message) {
  if (!clientInstance) {
    throw new Error("WhatsApp client not initialized.");
  }

  await waitForWhatsAppReady();

  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) {
    throw new Error("Invalid phone number.");
  }

  const chatId = `${digits}@c.us`;
  await clientInstance.sendMessage(chatId, message);
}

function isWhatsAppReady() {
  return ready;
}

function getLatestQr() {
  return latestQr || null;
}

async function waitForQr(timeoutMs = 20000) {
  const start = Date.now();
  while (!latestQr && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return latestQr || null;
}

async function reconnectWhatsAppSession() {
  if (reconnecting) {
    return { ok: false, message: "Reconnect already in progress." };
  }

  reconnecting = true;

  try {
    const clientId = process.env.WHATSAPP_CLIENT_ID || "default";
    const sessionName = sessionNameFromClientId(clientId);
    const store = new PostgresSessionStore({ queryFn: query });

    if (clientInstance) {
      try {
        await clientInstance.destroy();
      } catch {
        // no-op
      }
      clientInstance = null;
      ready = false;
    }

    await store.delete({ session: sessionName });
    await startWhatsAppClient();
    const qr = await waitForQr();

    return {
      ok: true,
      message: "Reconnect initialized. Scan QR from response/logs.",
      qr,
    };
  } finally {
    reconnecting = false;
  }
}

function getWhatsAppStatus() {
  return {
    ready,
    reconnecting,
    statusMessage,
    hasQr: Boolean(latestQr),
  };
}

async function closeWhatsAppClient() {
  if (backupIntervalRef) {
    clearInterval(backupIntervalRef);
    backupIntervalRef = null;
  }
  if (clientInstance) {
    await clientInstance.destroy();
    clientInstance = null;
  }
  latestQr = null;
  ready = false;
  statusMessage = "closed";
}

module.exports = {
  startWhatsAppClient,
  closeWhatsAppClient,
  sendWhatsAppMessage,
  isWhatsAppReady,
  getLatestQr,
  getWhatsAppStatus,
  reconnectWhatsAppSession,
};
