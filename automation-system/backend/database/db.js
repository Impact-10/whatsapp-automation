const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const logger = require("../utils/logger");

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : false,
  keepAlive: true,
});

pool.on("error", (err) => {
  logger.error("Unexpected PostgreSQL pool error", { error: err.message });
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function getClient() {
  const client = await pool.connect();

  // Prevent client-level network errors from crashing the whole Node process.
  client.on("error", (err) => {
    logger.error("PostgreSQL client error", { error: err.message });
  });

  return client;
}

async function withTransaction(work) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error("PostgreSQL rollback failed", { error: rollbackError.message });
    }
    throw error;
  } finally {
    client.removeAllListeners("error");
    client.release();
  }
}

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing in .env");
  }

  const schemaPath = path.join(__dirname, "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schemaSql);
  logger.info("Database schema initialized.");
}

async function closeDatabase() {
  await pool.end();
}

module.exports = {
  query,
  getClient,
  withTransaction,
  initDatabase,
  closeDatabase,
};
