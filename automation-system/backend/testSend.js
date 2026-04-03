const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const logger = require("./utils/logger");
const { initDatabase, closeDatabase } = require("./database/db");
const { startWhatsAppClient, closeWhatsAppClient, sendWhatsAppMessage } = require("./whatsapp/whatsappClient");
const { logMessage } = require("./services/reminderService");
const { normalizePhone } = require("./services/sheetsService");

async function runTestSend() {
  const receiver = normalizePhone(process.argv[2] || process.env.TEST_RECEIVER || "+919486655791");

  await initDatabase();
  await startWhatsAppClient();

  const message = [
    "Hello Kavin Ragul",
    "",
    "Reminder from Vet Clinic.",
    "",
    "G wagon is due for the Rabies vaccine on 2026-04-10.",
    "",
    "Please visit the clinic.",
    "",
    "Thank you.",
  ].join("\n");

  try {
    await sendWhatsAppMessage(receiver, message);
    await logMessage({ phone: receiver, message, status: "sent" });
    logger.info("Test message sent.", { receiver });
  } catch (error) {
    await logMessage({ phone: receiver, message, status: "failed", errorMessage: error.message });
    throw error;
  } finally {
    await closeWhatsAppClient();
    await closeDatabase();
  }
}

runTestSend().catch((error) => {
  logger.error("Test send failed.", { error: error.message });
  process.exit(1);
});
