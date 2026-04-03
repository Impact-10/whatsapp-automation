const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const logger = require("../utils/logger");

if (!process.env.DATABASE_URL) {
  logger.warn("DATABASE_URL is empty. Add it to .env before running DB operations.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  logger.error("Unexpected PostgreSQL pool error", { error: err.message });
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to initialize the database.");
  }

  const migrationsPath = path.join(__dirname, "migrations.sql");
  const sql = fs.readFileSync(migrationsPath, "utf8");
  await pool.query(sql);
  logger.info("Database migrations completed.");
}

async function closeDatabase() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  initializeDatabase,
  closeDatabase,
};
