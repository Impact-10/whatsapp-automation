const { query } = require("../database/db");

async function getLatestSessionInfo() {
  const { rows } = await query(
    `
      SELECT session_name, octet_length(session_data) AS bytes, updated_at
      FROM whatsapp_sessions
      ORDER BY updated_at DESC
      LIMIT 1
    `
  );

  return rows[0] || null;
}

function isSessionBlobHealthy(sessionInfo) {
  if (!sessionInfo) return false;
  return Number(sessionInfo.bytes || 0) > 4096;
}

module.exports = {
  getLatestSessionInfo,
  isSessionBlobHealthy,
};
