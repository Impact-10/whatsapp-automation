const cron = require("node-cron");
const logger = require("../utils/logger");
const { fetchSheetRows } = require("../services/sheetsService");
const { syncRemindersFromSheet, enqueueDueRemindersForToday } = require("../services/reminderService");

async function runSyncAndQueueCycle() {
  logger.info("Scheduler cycle started.");

  const sheetRows = await fetchSheetRows();
  const synced = await syncRemindersFromSheet(sheetRows);
  const queueResult = await enqueueDueRemindersForToday();

  const result = {
    synced,
    ...queueResult,
  };

  logger.info("Scheduler cycle finished.", result);
  return result;
}

function scheduleDailyRun() {
  const expression = process.env.CRON_SCHEDULE || "0 9 * * *";
  const timezone = process.env.APP_TIMEZONE || "Asia/Kolkata";

  if (!cron.validate(expression)) {
    throw new Error(`Invalid CRON_SCHEDULE: ${expression}`);
  }

  const task = cron.schedule(
    expression,
    async () => {
      try {
        await runSyncAndQueueCycle();
      } catch (error) {
        logger.error("Cron run failed.", { error: error.message });
      }
    },
    { timezone }
  );

  logger.info("Cron scheduled.", { expression, timezone });
  return task;
}

module.exports = {
  runSyncAndQueueCycle,
  scheduleDailyRun,
};
