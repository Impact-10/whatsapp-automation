const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const logger = require("./utils/logger");
const { initializeDatabase, closeDatabase } = require("./database/db");
const { WhatsAppClient } = require("./whatsapp/whatsappClient");
const { runReminderPipeline, startDailyReminderJob } = require("./scheduler/cronJobs");

function validateRequiredEnv() {
  const requiredKeys = ["DATABASE_URL", "GOOGLE_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT"];
  const missing = requiredKeys.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

async function main() {
  validateRequiredEnv();
  await initializeDatabase();

  const syncOnly = process.argv.includes("--sync-only");

  if (syncOnly) {
    logger.info("Running sync-only mode.");
    const client = new WhatsAppClient();
    await client.launch();
    await runReminderPipeline(client);
    await client.close();
    await closeDatabase();
    process.exit(0);
  }

  const whatsAppClient = new WhatsAppClient();
  await whatsAppClient.launch();

  startDailyReminderJob(whatsAppClient);

  logger.info("Application started. Waiting for scheduled cron runs.");

  const shutdown = async () => {
    logger.info("Shutting down application...");
    await whatsAppClient.close();
    await closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  logger.error("Application startup failed.", { error: error.message });
  process.exit(1);
});
