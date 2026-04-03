const { query } = require("../database/db");
const logger = require("../utils/logger");

async function upsertClient(clientName, phone) {
  const sql = `
    INSERT INTO clients (name, phone)
    VALUES ($1, $2)
    ON CONFLICT (phone)
    DO UPDATE SET name = EXCLUDED.name
    RETURNING id;
  `;

  const { rows } = await query(sql, [clientName, phone]);
  return rows[0].id;
}

async function upsertPet(clientId, petName) {
  const sql = `
    INSERT INTO pets (client_id, pet_name, species)
    VALUES ($1, $2, 'Unknown')
    ON CONFLICT (client_id, pet_name)
    DO UPDATE SET pet_name = EXCLUDED.pet_name
    RETURNING id;
  `;

  const { rows } = await query(sql, [clientId, petName]);
  return rows[0].id;
}

async function upsertReminder(petId, vaccineName, nextDueDate) {
  const sql = `
    INSERT INTO reminders (pet_id, vaccine_name, next_due_date)
    VALUES ($1, $2, $3)
    ON CONFLICT (pet_id, vaccine_name, next_due_date)
    DO UPDATE SET
      vaccine_name = EXCLUDED.vaccine_name,
      next_due_date = EXCLUDED.next_due_date,
      updated_at = NOW()
    RETURNING id;
  `;

  const { rows } = await query(sql, [petId, vaccineName, nextDueDate]);
  return rows[0].id;
}

async function syncSheetRows(rows) {
  let synced = 0;

  for (const row of rows) {
    const clientId = await upsertClient(row.ownerName, normalizePhone(row.phone));
    const petId = await upsertPet(clientId, row.petName);
    await upsertReminder(petId, row.vaccineName, row.nextDueDate);
    synced += 1;
  }

  logger.info("Sheet sync completed.", { syncedRows: synced });
  return { syncedRows: synced };
}

function normalizePhone(phone) {
  return String(phone).replace(/[^\d]/g, "");
}

async function getDueReminders() {
  const sql = `
    SELECT
      r.id AS reminder_id,
      c.name AS owner,
      c.phone,
      p.pet_name,
      r.vaccine_name,
      r.next_due_date
    FROM reminders r
    INNER JOIN pets p ON p.id = r.pet_id
    INNER JOIN clients c ON c.id = p.client_id
    WHERE r.next_due_date = CURRENT_DATE
    ORDER BY c.name ASC;
  `;

  const { rows } = await query(sql);
  return rows;
}

async function logMessageDelivery({ reminderId, phone, message, status, errorMessage = null }) {
  const sql = `
    INSERT INTO message_logs (reminder_id, phone, message, status, error_message, sent_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
  `;

  await query(sql, [reminderId, phone, message, status, errorMessage]);
}

async function insertDummyTestData({ ownerName, phone, petName, vaccineName }) {
  const clientId = await upsertClient(ownerName, normalizePhone(phone));
  const petId = await upsertPet(clientId, petName);
  const reminderId = await upsertReminder(petId, vaccineName, new Date().toISOString().slice(0, 10));

  logger.info("Dummy test data inserted.", { reminderId, phone: normalizePhone(phone) });
  return reminderId;
}

module.exports = {
  syncSheetRows,
  getDueReminders,
  logMessageDelivery,
  insertDummyTestData,
  normalizePhone,
};
