const db = require("../db");

function log(level, service, message, meta = null) {
  db.prepare(`
    INSERT INTO service_logs (level, service, message, meta, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    level,
    service,
    message,
    meta ? JSON.stringify(meta) : null,
    Date.now()
  );

  console.log(`[${level.toUpperCase()}] [${service}] ${message}`, meta || "");
}

module.exports = {
  info: (service, message, meta) => log("info", service, message, meta),
  warn: (service, message, meta) => log("warn", service, message, meta),
  error: (service, message, meta) => log("error", service, message, meta),
};
