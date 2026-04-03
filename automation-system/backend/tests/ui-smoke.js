"use strict";

const path = require("path");
const puppeteer = require("puppeteer");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const port = process.env.API_PORT || 3000;
const key = process.env.ADMIN_API_KEY || "";
const url = `http://localhost:${port}/admin?key=${key}`;

(async () => {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  await page.goto(url, { waitUntil: "networkidle2" });

  const title = await page.$eval("#page-title", el => el.textContent.trim());
  const hasStats = await page.$("#s-clients") !== null;
  const hasSidebar = await page.$(".sidebar") !== null;

  if (title !== "Overview") {
    throw new Error(`Unexpected page title: ${title}`);
  }
  if (!hasStats || !hasSidebar) {
    throw new Error("Missing expected UI elements");
  }

  await browser.close();
  console.log("UI smoke test passed");
})().catch(err => {
  console.error("UI smoke test failed:", err.message);
  process.exit(1);
});
