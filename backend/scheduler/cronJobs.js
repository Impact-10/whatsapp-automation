const cron = require("node-cron");
const logger = require("../utils/logger");
const { readReminderRows } = require("../services/sheetsService");
const { syncSheetRows } = require("../services/reminderService");
const { sendDueReminders } = require("../services/messageService");

async function runReminderPipeline(whatsAppClient) {
  logger.info("Reminder pipeline started.");

  const rows = await readReminderRows();
  await syncSheetRows(rows);
  const sendResult = await sendDueReminders(whatsAppClient);

  logger.info("Reminder pipeline finished.", sendResult);
  return sendResult;
}

function startDailyReminderJob(whatsAppClient) {
  const cronSchedule = process.env.CRON_SCHEDULE || "0 9 * * *";
  const timezone = process.env.APP_TIMEZONE || "UTC";

  if (!cron.validate(cronSchedule)) {
    throw new Error(`Invalid cron expression: ${cronSchedule}`);
  }

  const task = cron.schedule(
    cronSchedule,
    async () => {
      try {
        await runReminderPipeline(whatsAppClient);
      } catch (error) {
        logger.error("Daily cron job failed.", { error: error.message });
      }
    },
    {
      timezone,
    }
  );

  logger.info("Daily reminder cron started.", { cronSchedule, timezone });
  return task;
}

module.exports = {
  startDailyReminderJob,
  runReminderPipeline,
};
