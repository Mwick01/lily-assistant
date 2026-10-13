const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const config = require("./config");

const dbPath = path.resolve(config.databasePath);
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some((col) => col.name === column);

  if (!exists) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}


db.exec(`
CREATE TABLE IF NOT EXISTS thread_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  wa_message_id TEXT NOT NULL UNIQUE,
  quoted_wa_id TEXT,
  role TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  text TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_wa_id
ON thread_messages(wa_message_id);

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id
ON thread_messages(thread_id);

CREATE TABLE IF NOT EXISTS guardrail_state (
  chat_id TEXT PRIMARY KEY,
  active_reading_enabled INTEGER DEFAULT 1,
  reply_mode TEXT DEFAULT 'all',
  no_reply_until INTEGER DEFAULT 0,
  updated_by TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS service_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  service TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  message TEXT NOT NULL,
  quoted_message_id TEXT,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL UNIQUE,
  code_a TEXT NOT NULL,
  code_b TEXT,
  name TEXT NOT NULL,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS lecture_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  scheduled_start INTEGER NOT NULL,
  scheduled_end INTEGER NOT NULL,
  status TEXT DEFAULT 'scheduled',
  reason TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  FOREIGN KEY(course_id) REFERENCES courses(id)
);

CREATE INDEX IF NOT EXISTS idx_lecture_events_course_id
ON lecture_events(course_id);

CREATE INDEX IF NOT EXISTS idx_lecture_events_time
ON lecture_events(scheduled_start, scheduled_end);

CREATE TABLE IF NOT EXISTS lecture_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lecture_id INTEGER,
  course_id INTEGER,
  action TEXT NOT NULL,

  old_start INTEGER,
  old_end INTEGER,
  old_status TEXT,
  old_mode TEXT,
  old_location TEXT,
  old_platform TEXT,

  new_start INTEGER,
  new_end INTEGER,
  new_status TEXT,
  new_mode TEXT,
  new_location TEXT,
  new_platform TEXT,

  reason TEXT,
  performed_by TEXT,
  performed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lecture_history_lecture_id
ON lecture_history(lecture_id);

CREATE INDEX IF NOT EXISTS idx_lecture_history_course_id
ON lecture_history(course_id);
`);

addColumnIfMissing("lecture_events", "mode", "TEXT");
addColumnIfMissing("lecture_events", "location", "TEXT");
addColumnIfMissing("lecture_events", "platform", "TEXT");
addColumnIfMissing("lecture_events", "meeting_link", "TEXT");
addColumnIfMissing("lecture_events", "confirmed_at", "INTEGER");
addColumnIfMissing("lecture_events", "tentative_reminder_sent_at", "INTEGER");

addColumnIfMissing("outbound_queue", "thread_id", "TEXT");
addColumnIfMissing("outbound_queue", "store_as_assistant", "INTEGER DEFAULT 0");

addColumnIfMissing("lecture_events", "cancelled_at", "INTEGER");
addColumnIfMissing("lecture_events", "cancel_reason", "TEXT");
addColumnIfMissing("lecture_events", "reschedule_reason", "TEXT");

module.exports = db;
