const express = require("express");
const { Pool } = require("pg");
const { setup, log, register, promClient } = require("../_shared");

const app = express();
const port = process.env.PORT || 3001;
// Time a /reports/export holds its connection while the result is written out.
const exportHoldMs = Number(process.env.EXPORT_HOLD_MS || 4000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PG* env vars supply host/user/database.
const pool = new Pool({
  max: Number(process.env.DB_POOL_MAX || 10),
  connectionTimeoutMillis: 2000,
  query_timeout: 5000,
  idleTimeoutMillis: 30000,
});
pool.on("error", (err) => log("error", "idle client error", { error: { code: err.code || "DB_ERROR", message: err.message } }));

new promClient.Gauge({
  name: "db_pool_connections",
  help: "Connections in the pool by state",
  labelNames: ["state"],
  registers: [register],
  collect() {
    this.set({ state: "total" }, pool.totalCount);
    this.set({ state: "idle" }, pool.idleCount);
    this.set({ state: "waiting" }, pool.waitingCount);
  },
});
const dbDuration = new promClient.Histogram({
  name: "db_query_duration_seconds",
  help: "Query execution time (excludes waiting for a pooled connection)",
  labelNames: ["query"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

async function timed(req, name, db, sql, params) {
  const start = process.hrtime.bigint();
  try {
    return await db.query(sql, params);
  } finally {
    const s = Number(process.hrtime.bigint() - start) / 1e9;
    dbDuration.observe({ query: name }, s);
    if (s > 0.3) {
      const ms = Math.round(s * 1000);
      log("warn", `slow query ${ms}ms on orders`, { request_id: req.id, query: name, table: "orders", duration_ms: ms });
    }
  }
}

async function query(req, name, sql, params) {
  const client = await pool.connect();
  try {
    return await timed(req, name, client, sql, params);
  } finally {
    client.release();
  }
}

// Last lookup per session, kept for repeat-view requests. Never evicted.
const sessionHistory = new Map();

setup(app);
app.use(express.json());

app.post("/orders", async (req, res) => {
  const { customer_id, total_cents } = req.body || {};
  if (!Number.isInteger(customer_id) || !Number.isInteger(total_cents) || total_cents < 0) {
    return res.status(400).json({ error: "customer_id and total_cents must be integers" });
  }
  const r = await query(req, "insert_order",
    "INSERT INTO orders (customer_id, status, total_cents) VALUES ($1, 'new', $2) RETURNING *",
    [customer_id, total_cents]);
  res.status(201).json(r.rows[0]);
});

app.get("/orders/:id", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "invalid id" });
  const r = await query(req, "get_order", "SELECT * FROM orders WHERE id = $1", [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: "order not found" });
  res.json(r.rows[0]);
});

app.get("/orders", async (req, res) => {
  const customerId = Number(req.query.customer_id);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "customer_id required" });
  const r = await query(req, "list_orders",
    "SELECT * FROM orders WHERE customer_id = $1 ORDER BY id DESC LIMIT 50", [customerId]);
  const sid = req.get("x-session-id");
  if (sid) sessionHistory.set(sid, { customerId, rows: r.rows });
  res.json(r.rows);
});

app.post("/reports/export", async (req, res) => {
  const client = await pool.connect();
  try {
    const r = await timed(req, "export_orders", client,
      "SELECT customer_id, count(*)::int AS orders, sum(total_cents)::bigint AS revenue FROM orders GROUP BY customer_id");
    await sleep(exportHoldMs); // result is written out while the connection is held
    res.json({ customers: r.rowCount });
  } finally {
    client.release();
  }
});

app.use((err, req, res, _next) => {
  const status = err.status || (/timeout exceeded when trying to connect/.test(err.message) ? 503 : 500);
  if (status >= 500) res.locals.error = { code: err.code || "DB_ERROR", message: err.message };
  res.status(status).json({ error: status >= 500 ? "internal error" : err.message });
});

app.listen(port, "0.0.0.0", () => log("info", `listening on port ${port}`));
