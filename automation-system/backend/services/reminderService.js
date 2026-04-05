const { query } = require("../database/db");
const logger = require("../utils/logger");
const { buildReminderMessage, buildOverdueMessage } = require("./messageService");
const { getMessageTemplate, getSetting } = require("./settingsService");
const { enqueueMessage } = require("./queueService");

function envBool(name, defaultValue = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveTestSendTime() {
  const raw = String(process.env.TEST_SEND_TIME || "").trim();
  if (!raw) return null;

  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

async function prepareTestDueNow() {
  const tz = process.env.APP_TIMEZONE || "Asia/Kolkata";

  // Force every reminder to be due today so full pipeline can be tested in one run.
  await query(
    `UPDATE reminders
     SET next_due_date = (CURRENT_TIMESTAMP AT TIME ZONE $1)::DATE,
         follow_up_count = 0,
         visited = FALSE`,
    [tz]
  );

  if (envBool("TEST_CLEAR_QUEUE_AND_TODAY_LOGS", false)) {
    await query("DELETE FROM message_queue");
    await query(
      `DELETE FROM message_logs
       WHERE DATE(sent_at AT TIME ZONE $1) = (CURRENT_TIMESTAMP AT TIME ZONE $1)::DATE`,
      [tz]
    );
  }
}

async function upsertClient(name, phone) {
  const { rows } = await query(
    `INSERT INTO clients (name, phone) VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name, phone]
  );
  return rows[0].id;
}

async function upsertPet(clientId, petName) {
  await query(
    `INSERT INTO pets (client_id, pet_name) VALUES ($1, $2)
     ON CONFLICT (client_id, pet_name) DO NOTHING`,
    [clientId, petName]
  );
  const { rows } = await query(
    `SELECT id FROM pets WHERE client_id = $1 AND pet_name = $2`,
    [clientId, petName]
  );
  return rows[0].id;
}

async function upsertReminder(petId, vaccine, firstVisitDate, frequencyDays) {
  const { rows } = await query(
    `INSERT INTO reminders (pet_id, vaccine, first_visit_date, frequency_days, next_due_date)
     VALUES ($1, $2, $3::DATE, $4::INT, $3::DATE + ($4::INT * INTERVAL '1 day'))
     ON CONFLICT (pet_id, vaccine) DO UPDATE SET
       first_visit_date = EXCLUDED.first_visit_date,
       frequency_days   = EXCLUDED.frequency_days,
       next_due_date    = CASE
         WHEN reminders.frequency_days != EXCLUDED.frequency_days
           THEN COALESCE(reminders.last_visited_date, EXCLUDED.first_visit_date)
                + (EXCLUDED.frequency_days * INTERVAL '1 day')
         ELSE reminders.next_due_date
       END
     RETURNING id`,
    [petId, vaccine, firstVisitDate, frequencyDays]
  );
  return rows[0].id;
}

async function syncRemindersFromSheet(rows) {
  let synced = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const clientId = await upsertClient(row.ownerName, row.phone);
      const petId = await upsertPet(clientId, row.petName);
      await upsertReminder(petId, row.vaccine, row.firstVisitDate, row.frequencyDays);
      synced++;
    } catch (err) {
      failed++;
      logger.error("Failed to sync sheet row.", {
        ownerName: row.ownerName,
        phone: row.phone,
        error: err.message,
      });
    }
  }

  logger.info("Sheet sync complete.", { synced, failed, total: rows.length });
  return synced;
}

/**
 * Get all reminders that are due (next_due_date <= today).
 * Groups by phone so we can send one combined message per owner.
 */
async function getDueRemindersToday() {
  const tz = process.env.APP_TIMEZONE || "Asia/Kolkata";
  const { rows } = await query(
    `SELECT
       r.id          AS reminder_id,
       c.name        AS owner_name,
       c.phone,
       p.pet_name,
       r.vaccine,
       r.next_due_date,
       r.frequency_days,
       r.follow_up_count
     FROM reminders r
     INNER JOIN pets p ON p.id = r.pet_id
     INNER JOIN clients c ON c.id = p.client_id
     WHERE r.next_due_date <= (CURRENT_TIMESTAMP AT TIME ZONE $1)::DATE
     ORDER BY c.name`,
    [tz]
  );
  return rows;
}

async function alreadySentToday(phone) {
  const tz = process.env.APP_TIMEZONE || "Asia/Kolkata";

  const { rows: logRows } = await query(
    `SELECT EXISTS (
       SELECT 1 FROM message_logs
       WHERE phone = $1
         AND status = 'sent'
         AND DATE(sent_at AT TIME ZONE $2) = (CURRENT_TIMESTAMP AT TIME ZONE $2)::DATE
     ) AS already_sent`,
    [phone, tz]
  );
  if (logRows[0].already_sent) return true;

  const { rows: queueRows } = await query(
    `SELECT EXISTS (
       SELECT 1 FROM message_queue
       WHERE phone = $1
         AND status IN ('queued', 'processing')
         AND DATE(queued_at AT TIME ZONE $2) = (CURRENT_TIMESTAMP AT TIME ZONE $2)::DATE
     ) AS in_queue`,
    [phone, tz]
  );
  return queueRows[0].in_queue;
}

async function alreadySentSuccessfullyToday(phone) {
  const tz = process.env.APP_TIMEZONE || "Asia/Kolkata";
  const { rows } = await query(
    `SELECT EXISTS (
       SELECT 1 FROM message_logs
       WHERE phone = $1
         AND status = 'sent'
         AND DATE(sent_at AT TIME ZONE $2) = (CURRENT_TIMESTAMP AT TIME ZONE $2)::DATE
     ) AS already_sent`,
    [phone, tz]
  );
  return rows[0].already_sent;
}

/**
 * Core scheduling logic:
 * 1. Get all due reminders
 * 2. Group by phone (one message per owner per day)
 * 3. For first-time due: send normal reminder, advance next_due, set follow_up_count=0
 * 4. For follow-ups (already sent initial but not visited): send overdue message every N days
 * 5. After max follow-ups: auto-advance to next cycle
 */
async function enqueueDueRemindersForToday() {
  if (envBool("TEST_FORCE_DUE_TODAY", false)) {
    await prepareTestDueNow();
  }

  const dueRows = await getDueRemindersToday();
  const template = await getMessageTemplate();
  const overdueTemplate = await getSetting("overdue_message_template");
  const maxFollowUps = parseInt(await getSetting("max_follow_ups")) || 3;
  const followUpInterval = parseInt(await getSetting("follow_up_interval_days")) || 5;
  const testSendTime = resolveTestSendTime();
  const tz = process.env.APP_TIMEZONE || "Asia/Kolkata";

  // Group by phone for combined messages
  const byPhone = {};
  for (const row of dueRows) {
    if (!byPhone[row.phone]) byPhone[row.phone] = { ownerName: row.owner_name, items: [] };
    byPhone[row.phone].items.push(row);
  }

  let queued = 0;
  let duplicates = 0;
  let autoAdvanced = 0;

  for (const phone of Object.keys(byPhone)) {
    if (await alreadySentToday(phone)) {
      duplicates++;
      continue;
    }

    const group = byPhone[phone];
    const itemsToRemind = [];
    const itemsToAutoAdvance = [];

    for (const item of group.items) {
      if (item.follow_up_count >= maxFollowUps) {
        itemsToAutoAdvance.push(item);
      } else {
        itemsToRemind.push(item);
      }
    }

    // Auto-advance exhausted items to next cycle
    for (const item of itemsToAutoAdvance) {
      await query(
        `UPDATE reminders
         SET next_due_date = next_due_date + (frequency_days * INTERVAL '1 day'),
             follow_up_count = 0,
             visited = FALSE
         WHERE id = $1`,
        [item.reminder_id]
      );
      autoAdvanced++;
    }

    if (!itemsToRemind.length) continue;

    // Determine if this is a follow-up (any item has follow_up_count > 0)
    const isFollowUp = itemsToRemind.some(i => i.follow_up_count > 0);

    // Build combined message for all pets due for this owner
    let message;
    if (isFollowUp && overdueTemplate) {
      message = buildOverdueMessage({
        ownerName: group.ownerName,
        items: itemsToRemind,
        template: overdueTemplate,
      });
    } else {
      message = buildReminderMessage({
        ownerName: group.ownerName,
        items: itemsToRemind,
        template,
      });
    }

    // Use the earliest due date for the queue uniqueness key
    const earliestDue = itemsToRemind.reduce(
      (min, i) => (!min || i.next_due_date < min ? i.next_due_date : min),
      null
    );

    const queueId = await enqueueMessage({
      reminderId: itemsToRemind[0].reminder_id,
      phone,
      message,
      reminderDate: new Date().toISOString().slice(0, 10),
      sendAfterTime: testSendTime,
      timezone: tz,
    });

    if (queueId) {
      // For initial send: advance next_due to next cycle for follow-up scheduling
      // For follow-ups: just increment follow_up_count, schedule next follow-up
      for (const item of itemsToRemind) {
        if (item.follow_up_count === 0) {
          // First send — schedule follow-up by setting next_due to follow-up interval from now
          await query(
            `UPDATE reminders
             SET follow_up_count = 1,
                 visited = FALSE,
                 next_due_date = CURRENT_DATE + ($2 * INTERVAL '1 day')
             WHERE id = $1`,
            [item.reminder_id, followUpInterval]
          );
        } else {
          // Follow-up send — increment count, schedule next follow-up
          await query(
            `UPDATE reminders
             SET follow_up_count = follow_up_count + 1,
                 next_due_date = CURRENT_DATE + ($2 * INTERVAL '1 day')
             WHERE id = $1`,
            [item.reminder_id, followUpInterval]
          );
        }
      }
      queued++;
    } else {
      duplicates++;
    }
  }

  const result = { due: dueRows.length, queued, duplicates, autoAdvanced };
  logger.info("Due reminders enqueued.", result);
  return result;
}

async function logMessage({ queueId = null, reminderId = null, phone, message, status, errorMessage = null }) {
  await query(
    `INSERT INTO message_logs (queue_id, reminder_id, phone, message, status, error_message, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [queueId, reminderId, phone, message, status, errorMessage]
  );
}

async function getAllReminders() {
  const { rows } = await query(
    `SELECT
       r.id             AS reminder_id,
       c.name           AS owner_name,
       c.phone,
       p.pet_name,
       r.vaccine,
       r.first_visit_date,
       r.frequency_days,
       r.next_due_date,
       r.last_visited_date,
       r.visited,
       r.follow_up_count
     FROM reminders r
     INNER JOIN pets p ON p.id = r.pet_id
     INNER JOIN clients c ON c.id = p.client_id
     ORDER BY r.next_due_date ASC, c.name ASC`
  );
  return rows;
}

async function updateFrequency(reminderId, frequencyDays) {
  const { rows } = await query(
    `UPDATE reminders
     SET frequency_days = $2::INT,
         next_due_date  = COALESCE(last_visited_date, first_visit_date) + ($2::INT * INTERVAL '1 day'),
         follow_up_count = 0
     WHERE id = $1
     RETURNING id, next_due_date, frequency_days`,
    [reminderId, frequencyDays]
  );
  return rows[0];
}

async function markVisited(reminderId) {
  // Update reminder
  const { rows } = await query(
    `UPDATE reminders
     SET visited          = TRUE,
         last_visited_date = CURRENT_DATE,
         next_due_date    = CURRENT_DATE + (frequency_days * INTERVAL '1 day'),
         follow_up_count  = 0
     WHERE id = $1
     RETURNING id, last_visited_date, next_due_date`,
    [reminderId]
  );
  if (!rows[0]) return null;

  // Record in visit history
  await query(
    `INSERT INTO visit_history (reminder_id, visited_date) VALUES ($1, CURRENT_DATE)`,
    [reminderId]
  );

  return rows[0];
}

async function getVisitHistory(reminderId) {
  const { rows } = await query(
    `SELECT id, visited_date, created_at FROM visit_history
     WHERE reminder_id = $1
     ORDER BY visited_date DESC`,
    [reminderId]
  );
  return rows;
}

async function deleteReminder(reminderId) {
  // Get pet_id before deleting so we can clean up orphan pets
  const { rows: reminderRows } = await query(
    `SELECT pet_id FROM reminders WHERE id = $1`,
    [reminderId]
  );
  if (!reminderRows.length) return null;

  const petId = reminderRows[0].pet_id;
  await query(`DELETE FROM reminders WHERE id = $1`, [reminderId]);

  // Clean up orphan pet (no remaining reminders)
  const { rows: remaining } = await query(
    `SELECT id FROM reminders WHERE pet_id = $1 LIMIT 1`,
    [petId]
  );
  if (!remaining.length) {
    // Get client_id before deleting pet
    const { rows: petRows } = await query(`SELECT client_id FROM pets WHERE id = $1`, [petId]);
    await query(`DELETE FROM pets WHERE id = $1`, [petId]);

    if (petRows.length) {
      const clientId = petRows[0].client_id;
      const { rows: remainingPets } = await query(
        `SELECT id FROM pets WHERE client_id = $1 LIMIT 1`,
        [clientId]
      );
      if (!remainingPets.length) {
        await query(`DELETE FROM clients WHERE id = $1`, [clientId]);
      }
    }
  }

  return { deleted: true };
}

async function getDashboardSummary() {
  const tz = process.env.APP_TIMEZONE || "Asia/Kolkata";
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*)::INT FROM clients)  AS total_clients,
       (SELECT COUNT(*)::INT FROM pets)     AS total_pets,
       (SELECT COUNT(*)::INT FROM reminders
        WHERE next_due_date <= (CURRENT_TIMESTAMP AT TIME ZONE $1)::DATE) AS due_today,
       (SELECT COUNT(*)::INT FROM message_logs
        WHERE status = 'sent'
          AND DATE(sent_at AT TIME ZONE $1) = (CURRENT_TIMESTAMP AT TIME ZONE $1)::DATE) AS sent_today,
       (SELECT COUNT(*)::INT FROM reminders WHERE visited = FALSE) AS pending_visits,
       (SELECT COUNT(*)::INT FROM reminders WHERE visited = TRUE)  AS total_visited`,
    [tz]
  );
  return rows[0];
}

async function getRecentLogs(limit = 20) {
  const { rows } = await query(
    `SELECT phone, message, status, error_message, sent_at
     FROM message_logs
     ORDER BY sent_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = {
  syncRemindersFromSheet,
  getDueRemindersToday,
  enqueueDueRemindersForToday,
  alreadySentToday,
  alreadySentSuccessfullyToday,
  logMessage,
  getAllReminders,
  updateFrequency,
  markVisited,
  getVisitHistory,
  deleteReminder,
  getDashboardSummary,
  getRecentLogs,
};

