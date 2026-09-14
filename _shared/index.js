// Shared instrumentation for every demo-shop service: uniform metrics, log
// schema, request ids, /health and /metrics. Services call setup(app) BEFORE
// registering their own routes and put any behaviour knobs inside handlers, so
// the measuring equipment (/health, /metrics, logs) is never affected by them.
const { randomUUID } = require("node:crypto");
const promClient = require("prom-client");

const SERVICE = process.env.SERVICE_NAME || "unknown";
const VERSION = process.env.APP_VERSION || "0.0.0";
const GIT_SHA = process.env.GIT_SHA || "unknown";
const QUIET_PATHS = new Set(["/health", "/metrics"]);

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

new promClient.Gauge({
  name: "app_build_info",
  help: "Build metadata, always 1",
  labelNames: ["version", "git_sha"],
  registers: [register],
}).set({ version: VERSION, git_sha: GIT_SHA }, 1);

const httpRequests = new promClient.Counter({
  name: "http_requests_total",
  help: "HTTP requests handled",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

const httpDuration = new promClient.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// One JSON object per line on stdout. Same keys on every service.
function log(level, message, fields = {}) {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    level,
    service: SERVICE,
    version: VERSION,
    message,
    ...fields,
  }));
}

function setup(app) {
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    req.id = req.get("x-request-id") || randomUUID();
    res.set("x-request-id", req.id);
    res.on("finish", () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      // unmatched requests share one label value: bounded cardinality
      const labels = {
        method: req.method,
        route: req.route?.path || "unmatched",
        status: String(res.statusCode),
      };
      httpRequests.inc(labels);
      httpDuration.observe(labels, seconds);
      if (QUIET_PATHS.has(req.path)) return;
      const failed = res.statusCode >= 500;
      log(failed ? "error" : "info", "request completed", {
        request_id: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Math.round(seconds * 1000),
        user_agent: req.get("user-agent"),
        // handlers set res.locals.error = {code, message} before replying 5xx
        ...(failed && { error: res.locals.error || { code: "INTERNAL", message: "internal error" } }),
      });
    });
    next();
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });
}

module.exports = { setup, log, register, promClient, SERVICE, VERSION };
