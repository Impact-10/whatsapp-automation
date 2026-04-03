const logger = require("../utils/logger");
const { getDueReminders, logMessageDelivery } = require("./reminderService");
const { sendWhatsAppMessage } = require("../whatsapp/sendMessage");

function buildReminderMessage({ owner, petName, vaccineName }) {
  return [
    `Hello ${owner}`,
    "",
    "Reminder from our Vet Clinic.",
    "",
    `${petName} is due for the ${vaccineName} vaccination today.`,
    "",
    "Please visit the clinic.",
    "",
    "Thank you.",
  ].join("\n");
}

async function retry(fn, maxRetries = 3) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt < maxRetries) {
        const delayMs = 1000 * attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

async function sendDueReminders(whatsAppClient) {
  const dueReminders = await getDueReminders();
  const maxRetries = Number(process.env.MAX_SEND_RETRIES || 3);

  if (dueReminders.length === 0) {
    logger.info("No due reminders for today.");
    return { total: 0, sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const reminder of dueReminders) {
    const message = buildReminderMessage({
      owner: reminder.owner,
      petName: reminder.pet_name,
      vaccineName: reminder.vaccine_name,
    });

    try {
      await retry(() => sendWhatsAppMessage(whatsAppClient, reminder.phone, message), maxRetries);
      await logMessageDelivery({
        reminderId: reminder.reminder_id,
        phone: reminder.phone,
        message,
        status: "sent",
      });
      sent += 1;
    } catch (error) {
      await logMessageDelivery({
        reminderId: reminder.reminder_id,
        phone: reminder.phone,
        message,
        status: "failed",
        errorMessage: error.message,
      });
      failed += 1;
      logger.error("Failed to send reminder.", {
        reminderId: reminder.reminder_id,
        error: error.message,
      });
    }
  }

  const result = { total: dueReminders.length, sent, failed };
  logger.info("Reminder send cycle completed.", result);
  return result;
}

module.exports = {
  buildReminderMessage,
  sendDueReminders,
};
