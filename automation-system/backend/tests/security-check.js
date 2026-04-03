"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const port = process.env.API_PORT || 3000;
const key = process.env.ADMIN_API_KEY || "";
const baseUrl = `http://localhost:${port}`;

async function req(url, opts = {}) {
  const res = await fetch(url, opts);
  return res;
}

(async () => {
  const unauth = await req(`${baseUrl}/admin/api/full-status`);
  const auth = await req(`${baseUrl}/admin/api/full-status`, {
    headers: { "x-api-key": key }
  });
  const admin = await req(`${baseUrl}/admin?key=${key}`);

  const headers = {};
  ["x-content-type-options", "x-frame-options", "referrer-policy", "content-security-policy"].forEach(h => {
    headers[h] = admin.headers.get(h) || "(missing)";
  });

  console.log("Unauthorized status:", unauth.status);
  console.log("Authorized status:", auth.status);
  console.log("Security headers:", headers);

  if (unauth.status !== 401) {
    throw new Error("Unauthorized full-status should return 401");
  }
  if (auth.status !== 200) {
    throw new Error("Authorized full-status should return 200");
  }

  console.log("Security checks passed");
})().catch(err => {
  console.error("Security checks failed:", err.message);
  process.exit(1);
});
