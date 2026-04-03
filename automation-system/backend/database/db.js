const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const logger = require("../utils/logger");

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  logger.error("Unexpected PostgreSQL pool error", { error: err.message });
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function getClient() {
  return pool.connect();
}

async function withTransaction(work) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
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
