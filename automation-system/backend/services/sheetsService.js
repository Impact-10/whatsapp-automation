const path = require("path");
const { google } = require("googleapis");
const logger = require("../utils/logger");

const REQUIRED_HEADERS = [
  "Owner Name",
  "Phone",
  "Pet Name",
  "Vaccine",
  "First Visit Date",
];

const REQUIRED_HEADER_ALIASES = {
  "Owner Name": ["Owner Name"],
  "Phone": ["Phone"],
  "Pet Name": ["Pet Name"],
  "Vaccine": ["Vaccine"],
  // Backward-compatible: support old sheet templates that used Next Due Date.
  "First Visit Date": ["First Visit Date", "Next Due Date"],
};

const OPTIONAL_HEADERS = [
  "Frequency Days",
  "Last Visited Date",
];

function parseSheetIdFromUrl(url) {
  const match = String(url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : "";
}

function normalizePhone(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D/g, "");
  if (!digits) return "";

  if (digits.length === 10) {
    return `+91${digits}`;
  }

  if (digits.length === 12 && digits.startsWith("91")) {
    return `+${digits}`;
  }

  if (digits.length > 10 && !String(rawPhone).includes("+")) {
    return `+${digits}`;
  }

  if (String(rawPhone).startsWith("+")) {
    return `+${digits}`;
  }

  return `+${digits}`;
}

function normalizeDate(rawDate) {
  if (!rawDate) return "";

  const parsed = new Date(rawDate);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  const match = String(rawDate).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const month = match[1].padStart(2, "0");
    const day = match[2].padStart(2, "0");
    const year = match[3];
    return `${year}-${month}-${day}`;
  }

  return "";
}

function loadServiceAccountCredentials() {
  function normalizeCredentials(creds) {
    if (!creds || typeof creds !== "object") return creds;

    if (typeof creds.private_key === "string") {
      // Render/UI pastes often keep escaped newlines; OpenSSL expects real newlines.
      creds.private_key = creds.private_key.replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
    }

    return creds;
  }

  // Cloud deployments (Render etc.) pass the full JSON as an env var string
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      return normalizeCredentials(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
    }
  }

  const input = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!input) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT file path is required.");
  }

  const resolvedPath = path.resolve(process.cwd(), input);
  return normalizeCredentials(require(resolvedPath));
}

function resolveSheetId() {
  if (process.env.SHEET_ID) {
    return process.env.SHEET_ID;
  }

  if (process.env.SHEET_URL) {
    const extracted = parseSheetIdFromUrl(process.env.SHEET_URL);
    if (extracted) {
      logger.info("Extracted SHEET_ID from SHEET_URL.", { sheetId: extracted });
      return extracted;
    }
  }

  throw new Error("SHEET_ID is missing, and SHEET_URL did not contain a valid sheet ID.");
}

async function getSheetsClient() {
  const credentials = loadServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

function resolveSheetName() {
  const range = process.env.SHEET_RANGE || "Sheet1!A:G";
  const parts = String(range).split("!");
  return parts[0] || "Sheet1";
}

async function getSheetIdByName(sheets, sheetName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: resolveSheetId(),
    fields: "sheets.properties",
  });
  const sheet = (meta.data.sheets || []).find((s) => s.properties?.title === sheetName);
  return sheet?.properties?.sheetId;
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase();
}

function buildHeaderIndex(headerRow) {
  const index = {};
  headerRow.forEach((h, i) => {
    index[normalizeHeader(h)] = i;
  });
  return index;
}

function resolveHeaderIndex(index, names) {
  for (const name of names) {
    const hit = index[normalizeHeader(name)];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function assertHeaders(headerRow) {
  const index = buildHeaderIndex(headerRow);
  const missing = REQUIRED_HEADERS.filter(
    (h) => resolveHeaderIndex(index, REQUIRED_HEADER_ALIASES[h] || [h]) === undefined
  );
  if (missing.length) {
    throw new Error(
      `Invalid sheet headers. Missing: ${missing.join(" | ")}. Found: ${headerRow.join(" | ")}`
    );
  }
  return index;
}

async function fetchSheetRows() {
  const sheetId = resolveSheetId();
  const range = process.env.SHEET_RANGE || "Sheet1!A:G";
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });

  const values = response.data.values || [];
  if (!values.length) {
    return [];
  }

  const headerIndex = assertHeaders(values[0]);
  const firstVisitIndex = resolveHeaderIndex(
    headerIndex,
    REQUIRED_HEADER_ALIASES["First Visit Date"]
  );
  const freqIndex = headerIndex[normalizeHeader("Frequency Days")];
  const lastVisitedIndex = headerIndex[normalizeHeader("Last Visited Date")];

  const result = values
    .slice(1)
    .map((row) => {
      const ownerName = row[headerIndex[normalizeHeader("Owner Name")]];
      const phone = row[headerIndex[normalizeHeader("Phone")]];
      const petName = row[headerIndex[normalizeHeader("Pet Name")]];
      const vaccine = row[headerIndex[normalizeHeader("Vaccine")]];
      const firstVisitDate = row[firstVisitIndex];
      const freqRaw = freqIndex !== undefined ? row[freqIndex] : null;
      const lastVisitedRaw = lastVisitedIndex !== undefined ? row[lastVisitedIndex] : null;

      return {
        ownerName: String(ownerName || "").trim(),
        phone: normalizePhone(phone),
        petName: String(petName || "").trim(),
        vaccine: String(vaccine || "").trim(),
        firstVisitDate: normalizeDate(firstVisitDate),
        frequencyDays: Math.max(1, parseInt(freqRaw) || 30),
        lastVisitedDate: normalizeDate(lastVisitedRaw) || null,
      };
    })
    .filter((r) => r.ownerName && r.phone && r.petName && r.vaccine && r.firstVisitDate);

  logger.info("Fetched rows from Google Sheets.", { rows: result.length });
  return result;
}

async function listSheetRows() {
  const sheetId = resolveSheetId();
  const range = process.env.SHEET_RANGE || "Sheet1!A:G";
  const sheetName = resolveSheetName();
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });

  const values = response.data.values || [];
  if (!values.length) {
    return { sheetName, rows: [] };
  }

  const headerIndex = assertHeaders(values[0]);
  const firstVisitIndex = resolveHeaderIndex(
    headerIndex,
    REQUIRED_HEADER_ALIASES["First Visit Date"]
  );
  const freqIndex = headerIndex[normalizeHeader("Frequency Days")];
  const lastVisitedIndex = headerIndex[normalizeHeader("Last Visited Date")];

  const rows = values.slice(1).map((row, i) => {
    const ownerName = row[headerIndex[normalizeHeader("Owner Name")]];
    const phone = row[headerIndex[normalizeHeader("Phone")]];
    const petName = row[headerIndex[normalizeHeader("Pet Name")]];
    const vaccine = row[headerIndex[normalizeHeader("Vaccine")]];
    const firstVisitDate = row[firstVisitIndex];
    const freqRaw = freqIndex !== undefined ? row[freqIndex] : "";
    const lastVisitedRaw = lastVisitedIndex !== undefined ? row[lastVisitedIndex] : "";

    return {
      rowNumber: i + 2,
      ownerName: String(ownerName || "").trim(),
      phone: normalizePhone(phone),
      petName: String(petName || "").trim(),
      vaccine: String(vaccine || "").trim(),
      firstVisitDate: normalizeDate(firstVisitDate),
      frequencyDays: Math.max(1, parseInt(freqRaw) || 30),
      lastVisitedDate: normalizeDate(lastVisitedRaw) || null,
    };
  });

  return { sheetName, rows };
}

async function appendSheetRow(data) {
  const sheetId = resolveSheetId();
  const sheetName = resolveSheetName();
  const sheets = await getSheetsClient();

  const row = [
    String(data.ownerName || "").trim(),
    normalizePhone(data.phone),
    String(data.petName || "").trim(),
    String(data.vaccine || "").trim(),
    normalizeDate(data.firstVisitDate),
    Math.max(1, parseInt(data.frequencyDays) || 30),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:F`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function deleteSheetRow(rowNumber) {
  if (!rowNumber || rowNumber < 2) {
    throw new Error("Invalid row number.");
  }

  const sheetName = resolveSheetName();
  const sheets = await getSheetsClient();
  const sheetId = await getSheetIdByName(sheets, sheetName);
  if (sheetId === undefined) {
    throw new Error("Sheet not found.");
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: resolveSheetId(),
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        },
      ],
    },
  });
}

module.exports = {
  fetchSheetRows,
  listSheetRows,
  appendSheetRow,
  deleteSheetRow,
  normalizePhone,
  parseSheetIdFromUrl,
};
