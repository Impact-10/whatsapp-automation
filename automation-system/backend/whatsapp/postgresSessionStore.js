const fs = require("fs");
const path = require("path");

function normalizeSessionKey(session) {
  return path.basename(String(session || "")).replace(/\.zip$/i, "");
}

class PostgresSessionStore {
  constructor({ queryFn }) {
    this.queryFn = queryFn;
  }

  async sessionExists({ session }) {
    const sessionKey = normalizeSessionKey(session);
    const sql = "SELECT 1 FROM whatsapp_sessions WHERE session_name = $1 LIMIT 1";
    const { rows } = await this.queryFn(sql, [sessionKey]);
    return rows.length > 0;
  }

  async save({ session }) {
    const zipPath = `${session}.zip`;
    const data = await fs.promises.readFile(zipPath);
    const sessionKey = normalizeSessionKey(session);

    const sql = `
      INSERT INTO whatsapp_sessions (session_name, session_data, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (session_name)
      DO UPDATE SET
        session_data = EXCLUDED.session_data,
        updated_at = NOW()
    `;

    await this.queryFn(sql, [sessionKey, data]);
  }

  async extract({ session, path }) {
    const sessionKey = normalizeSessionKey(session);
    const sql = "SELECT session_data FROM whatsapp_sessions WHERE session_name = $1 LIMIT 1";
    const { rows } = await this.queryFn(sql, [sessionKey]);

    if (!rows.length) {
      throw new Error(`Session not found in DB for: ${sessionKey}`);
    }

    await fs.promises.writeFile(path, rows[0].session_data);
  }

  async delete({ session }) {
    const sessionKey = normalizeSessionKey(session);
    await this.queryFn("DELETE FROM whatsapp_sessions WHERE session_name = $1", [sessionKey]);
  }
}

module.exports = {
  PostgresSessionStore,
};
