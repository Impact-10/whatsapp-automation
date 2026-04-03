"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const port = process.env.API_PORT || 3000;
const key = process.env.ADMIN_API_KEY || "";
const url = `http://localhost:${port}/admin/api/full-status`;

const durationMs = 15000;
const concurrency = 80;

async function worker(stopAt, stats) {
  while (Date.now() < stopAt) {
    const start = Date.now();
    try {
      const res = await fetch(url, { headers: { "x-api-key": key } });
      const ms = Date.now() - start;
      stats.times.push(ms);
      if (res.ok) stats.ok++; else stats.fail++;
      await res.arrayBuffer();
    } catch {
      stats.fail++;
    }
  }
}

(async () => {
  const stopAt = Date.now() + durationMs;
  const stats = { ok: 0, fail: 0, times: [] };
  await Promise.all(Array.from({ length: concurrency }, () => worker(stopAt, stats)));

  stats.times.sort((a, b) => a - b);
  const p95 = stats.times[Math.floor(stats.times.length * 0.95)] || 0;
  const avg = stats.times.length ? Math.round(stats.times.reduce((a, b) => a + b, 0) / stats.times.length) : 0;

  console.log("Stress test complete");
  console.log("Concurrency:", concurrency, "Duration(ms):", durationMs);
  console.log("OK:", stats.ok, "FAIL:", stats.fail, "AVG(ms):", avg, "P95(ms):", p95);
})();
