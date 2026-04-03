const logger = require("../utils/logger");
const {
  dequeueNextMessage,
  markQueuedWithDelay,
  markSent,
  markSkipped,
  markFailed,
} = require("../services/queueService");
const { alreadySentSuccessfullyToday, logMessage } = require("../services/reminderService");
const { sendWhatsAppMessage, isWhatsAppReady } = require("../whatsapp/whatsappClient");

let timer;
let running = false;
let currentRun = Promise.resolve();

async function processQueueOnce() {
  if (running) return;
  running = true;

  try {
    while (true) {
      const item = await dequeueNextMessage();
      if (!item) break;

      if (!isWhatsAppReady()) {
        await markQueuedWithDelay(item.id, "whatsapp_not_ready", 45);
        continue;
      }

      if (await alreadySentSuccessfullyToday(item.phone)) {
        await markSkipped(item.id, "already_sent_today");
        await logMessage({
          queueId: item.id,
          reminderId: item.reminder_id,
          phone: item.phone,
          message: item.message,
          status: "skipped",
          errorMessage: "already_sent_today",
        });
        continue;
      }

      try {
        await sendWhatsAppMessage(item.phone, item.message);
        await markSent(item.id);
        await logMessage({
          queueId: item.id,
          reminderId: item.reminder_id,
          phone: item.phone,
          message: item.message,
          status: "sent",
        });
      } catch (error) {
        const maxRetries = Number(process.env.MAX_SEND_RETRIES || 3);
        if (item.attempts < maxRetries) {
          await markQueuedWithDelay(item.id, error.message, item.attempts * 30 || 30);
        } else {
          await markFailed(item.id, error.message);
          await logMessage({
            queueId: item.id,
            reminderId: item.reminder_id,
            phone: item.phone,
            message: item.message,
            status: "failed",
            errorMessage: error.message,
          });
        }

        logger.error("Queue send failed.", {
          queueId: item.id,
          error: error.message,
        });
      }
    }
  } finally {
    running = false;
  }
}

function startMessageWorker() {
  const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS || 5000);
  timer = setInterval(() => {
    currentRun = processQueueOnce().catch((error) => {
      logger.error("Worker loop error.", { error: error.message });
    });
  }, intervalMs);

  logger.info("Message worker started.", { intervalMs });
}

async function stopMessageWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Wait for any in-flight processing to finish
  await currentRun;
}

module.exports = {
  startMessageWorker,
  stopMessageWorker,
  processQueueOnce,
};
