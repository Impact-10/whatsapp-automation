const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const logger = require("./utils/logger");
const { initializeDatabase, closeDatabase } = require("./database/db");
const { WhatsAppClient } = require("./whatsapp/whatsappClient");
const { insertDummyTestData } = require("./services/reminderService");
const { sendDueReminders } = require("./services/messageService");

async function runTestMode() {
  const receiverFromArg = process.argv[2];
  const receiver = receiverFromArg || process.env.TEST_RECEIVER_NUMBER;

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }

  if (!receiver) {
    throw new Error("Provide receiver number via: npm run test:whatsapp -- <receiver_number>");
  }

  await initializeDatabase();

  await insertDummyTestData({
    ownerName: "Test Owner",
    phone: receiver,
    petName: "Test Pet",
    vaccineName: "Rabies Booster",
  });

  const whatsAppClient = new WhatsAppClient();
  await whatsAppClient.launch();

  const result = await sendDueReminders(whatsAppClient);
  logger.info("Test mode completed.", result);

  await whatsAppClient.close();
  await closeDatabase();
}

runTestMode().catch(async (error) => {
  logger.error("Test mode failed.", { error: error.message });
  try {
    await closeDatabase();
  } catch {
    // no-op
  }
  process.exit(1);
});
