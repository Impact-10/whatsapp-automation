const fs = require("fs");
const { google } = require("googleapis");
const logger = require("../utils/logger");

const EXPECTED_HEADERS = [
  "Owner Name",
  "Phone",
  "Pet Name",
  "Vaccine",
  "Next Due Date",
];

function parseServiceAccount(rawValue) {
  if (!rawValue) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT is required.");
  }

  const trimmed = rawValue.trim();

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  if (fs.existsSync(trimmed)) {
    return JSON.parse(fs.readFileSync(trimmed, "utf8"));
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.startsWith("{")) {
      return JSON.parse(decoded);
    }
  } catch (err) {
    logger.warn("Failed to decode GOOGLE_SERVICE_ACCOUNT as base64", { error: err.message });
  }

  throw new Error(
    "GOOGLE_SERVICE_ACCOUNT must be JSON, a file path, or a base64-encoded JSON string."
  );
}

function normalizeDate(value) {
  if (!value) return null;

  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) {
    return asDate.toISOString().slice(0, 10);
  }

  const mdy = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const month = mdy[1].padStart(2, "0");
    const day = mdy[2].padStart(2, "0");
    const year = mdy[3];
    return `${year}-${month}-${day}`;
  }

  return null;
}

async function getSheetsClient() {
  const credentials = parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

function validateHeaders(headerRow = []) {
  const isValid = EXPECTED_HEADERS.every((header, index) => headerRow[index] === header);
  if (!isValid) {
    throw new Error(
      `Google Sheet header mismatch. Expected: ${EXPECTED_HEADERS.join(" | ")}`
    );
  }
}

async function readReminderRows() {
  if (!process.env.GOOGLE_SHEET_ID) {
    throw new Error("GOOGLE_SHEET_ID is required.");
  }

  const sheets = await getSheetsClient();
  const range = process.env.GOOGLE_SHEET_RANGE || "Sheet1!A:E";

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range,
  });

  const rows = response.data.values || [];

  if (rows.length === 0) {
    logger.warn("Google Sheet returned no rows.");
    return [];
  }

  validateHeaders(rows[0]);

  const reminders = rows
    .slice(1)
    .map((row) => {
      const [ownerName, phone, petName, vaccineName, nextDueDateRaw] = row;
      const nextDueDate = normalizeDate(nextDueDateRaw);

      return {
        ownerName: ownerName ? ownerName.trim() : "",
        phone: phone ? String(phone).trim() : "",
        petName: petName ? petName.trim() : "",
        vaccineName: vaccineName ? vaccineName.trim() : "",
        nextDueDate,
      };
    })
    .filter((item) => item.ownerName && item.phone && item.petName && item.vaccineName && item.nextDueDate);

  logger.info("Google Sheets rows loaded.", { rows: reminders.length });
  return reminders;
}

module.exports = {
  readReminderRows,
  EXPECTED_HEADERS,
};
