const express = require("express");
const { setup, log, register, promClient } = require("../_shared");

const app = express();
const port = process.env.PORT || 3000;
const ordersUrl = process.env.ORDERS_URL || "http://orders:3001";
const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 3000);

const upstreamRequests = new promClient.Counter({
  name: "upstream_requests_total",
  help: "Outbound requests by upstream and status",
  labelNames: ["upstream", "status"],
  registers: [register],
});
const upstreamDuration = new promClient.Histogram({
  name: "upstream_request_duration_seconds",
  help: "Outbound request latency in seconds",
  labelNames: ["upstream", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

async function callOrders(req, method, path, body) {
  const start = process.hrtime.bigint();
  let status = "error";
  const sid = req.get("x-session-id");
  try {
    const r = await fetch(ordersUrl + path, {
      method,
      headers: { "content-type": "application/json", "x-request-id": req.id, ...(sid && { "x-session-id": sid }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = String(r.status);
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    if (e.name === "TimeoutError") status = "timeout";
    throw e;
  } finally {
    const labels = { upstream: "orders", status };
    upstreamRequests.inc(labels);
    upstreamDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
  }
}

async function forward(req, res, method, path, body) {
  try {
    const r = await callOrders(req, method, path, body);
    if (r.status < 500) return res.status(r.status).json(r.body);
    res.locals.error = { code: "UPSTREAM_ERROR", message: `orders responded ${r.status}` };
    res.status(502).json({ error: "bad gateway" });
  } catch (e) {
    const timeout = e.name === "TimeoutError";
    res.locals.error = { code: timeout ? "ETIMEDOUT" : e.cause?.code || "UPSTREAM_ERROR", message: e.cause?.message || e.message };
    res.status(timeout ? 504 : 502).json({ error: timeout ? "gateway timeout" : "bad gateway" });
  }
}

setup(app);

app.get("/checkout", (req, res) =>
  forward(req, res, "POST", "/orders", {
    customer_id: 1 + Math.floor(Math.random() * 5000),
    total_cents: 500 + Math.floor(Math.random() * 20000),
  }));

app.get("/orders/:id", (req, res) => forward(req, res, "GET", `/orders/${encodeURIComponent(req.params.id)}`));

app.get("/customers/:id/orders", (req, res) =>
  forward(req, res, "GET", `/orders?customer_id=${encodeURIComponent(req.params.id)}`));

app.listen(port, "0.0.0.0", () => log("info", `listening on port ${port}`));
