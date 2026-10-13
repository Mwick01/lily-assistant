const cron = require("node-cron");
const db = require("../db");
const config = require("../config");
const guardrails = require("./guardrails.service");
const outboundQueue = require("../queues/outbound.queue");
const logger = require("./logger.service");

const TZ_OFFSET = "+05:30";

function cleanText(text) {
  return (text || "")
    .replace(/@\d+/g, "")
    .replace(/@Lily/gi, "")
    .replace(/^lily[\s,:\-]+/i, "")
    .trim();
}

function getCourse(aliasOrCode) {
  const key = aliasOrCode.toUpperCase();

  return db.prepare(`
    SELECT *
    FROM courses
    WHERE UPPER(alias) = ?
       OR UPPER(code_a) = ?
       OR UPPER(code_b) = ?
    LIMIT 1
  `).get(key, key, key);
}

function parseDateTime(dateText, timeText) {
  return new Date(`${dateText}T${timeText}:00${TZ_OFFSET}`).getTime();
}

function getDayRange(dateText) {
  const start = new Date(`${dateText}T00:00:00${TZ_OFFSET}`).getTime();
  const end = new Date(`${dateText}T23:59:59${TZ_OFFSET}`).getTime();
  return { start, end };
}

function formatCompactTime(ms) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(ms))
    .replace(/\s/g, "")
    .toUpperCase();
}

function ordinal(day) {
  const n = Number(day);

  if (n >= 11 && n <= 13) return `${n}th`;

  const last = n % 10;

  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;

  return `${n}th`;
}

function formatDayHeader(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo",
    weekday: "long",
    day: "numeric",
  }).formatToParts(new Date(ms));

  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  return `${weekday} (${ordinal(day)})`;
}

function formatPlace(row) {
  const value =
    row.mode === "online"
      ? row.platform || "online"
      : row.location || "location not set";

  const cleaned = String(value).trim();

  if (/^e[-\s]?learning$/i.test(cleaned)) return "E learning";
  if (/^zoom$/i.test(cleaned)) return "Zoom";
  if (/^google\s*meet$/i.test(cleaned)) return "Google Meet";

  return cleaned;
}

function getDateKey(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function getConfirmedRowsBetween(startMs, endMs) {
  return db.prepare(`
    SELECT le.*, c.alias, c.name
    FROM lecture_events le
    JOIN courses c ON c.id = le.course_id
    WHERE le.status = 'scheduled'
      AND le.scheduled_end >= ?
      AND le.scheduled_start <= ?
    ORDER BY le.scheduled_start ASC
  `).all(startMs, endMs);
}

function renderLectureSchedule(title, rows, emptyMessage = "No confirmed lectures found.") {
  if (rows.length === 0) {
    return `${title}\n${emptyMessage}`;
  }

  const groups = new Map();

  for (const row of rows) {
    const key = getDateKey(row.scheduled_start);

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(row);
  }

  const sections = [title];

  for (const groupRows of groups.values()) {
    const first = groupRows[0];

    const lines = groupRows.map((row) => {
      return (
        `${row.alias} - ${row.name} ` +
        `${formatCompactTime(row.scheduled_start)}-${formatCompactTime(row.scheduled_end)} ` +
        `${formatPlace(row)}`
      );
    });

    sections.push(`${formatDayHeader(first.scheduled_start)}\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

function listConfirmedLectures(title, startMs, endMs) {
  const rows = getConfirmedRowsBetween(startMs, endMs);
  return renderLectureSchedule(title, rows);
}

function listThisWeekLecturesSmart() {
  const { end } = getRangeForThisWeek();
  const now = Date.now();

  const remainingThisWeek = getConfirmedRowsBetween(now, end);

  if (remainingThisWeek.length > 0) {
    return renderLectureSchedule(
      "This week's remaining confirmed lectures:",
      remainingThisWeek
    );
  }

  const nextWeek = getRangeForNextWeek();
  const nextWeekRows = getConfirmedRowsBetween(nextWeek.start, nextWeek.end);

  if (nextWeekRows.length === 0) {
    return (
      "No more confirmed lectures for this week.\n" +
      "No confirmed lectures are recorded for next week yet."
    );
  }

  return renderLectureSchedule(
    "No more confirmed lectures for this week.\n\nHere are next week's confirmed lectures:",
    nextWeekRows
  );
}

function formatTimeRange(startMs, endMs) {
  const fmtDate = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
  });

  const fmtTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return `${fmtDate.format(new Date(startMs))}, ${fmtTime.format(new Date(startMs))}-${fmtTime.format(new Date(endMs))}`;
}


function formatDateOnly(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function parseMode(modeRaw, detailRaw) {
  const mode = (modeRaw || "").toLowerCase();
  const detail = (detailRaw || "").trim();

  if (!mode) {
    return {
      error: "Please include lecture mode: physical HallName or online Zoom/Google Meet.",
    };
  }

  if (mode === "physical") {
    if (!detail) {
      return {
        error: "Please include the lecture hall. Example: physical Hall A",
      };
    }

    return {
      mode: "physical",
      location: detail,
      platform: null,
      meetingLink: null,
    };
  }

  if (mode === "online") {
    if (!detail) {
      return {
        error: "Please include the online platform. Example: online Zoom or online Google Meet",
      };
    }

    return {
      mode: "online",
      location: null,
      platform: detail,
      meetingLink: null,
    };
  }

  return {
    error: "Lecture mode must be physical or online.",
  };
}

function describeMode(row) {
  if (row.mode === "physical") {
    return `Physical - ${row.location || "location not set"}`;
  }

  if (row.mode === "online") {
    return `Online - ${row.platform || "platform not set"}`;
  }

  return "Mode not set";
}

function createLecture(msg, match, status) {
  if (!guardrails.isOwner(msg.senderId)) {
    return "Only Sir can schedule lectures.";
  }

  const alias = match[2].toUpperCase();
  const date = match[3];
  const start = match[4];
  const end = match[5];
  const modeRaw = match[6];
  const detailRaw = match[7];

  const course = getCourse(alias);

  if (!course) {
    return `I could not find subject "${alias}". Try RS, EM, CTC, SOC, AI, KE, or RC.`;
  }

  const modeInfo = parseMode(modeRaw, detailRaw);

  if (modeInfo.error) {
    return modeInfo.error;
  }

  const startMs = parseDateTime(date, start);
  const endMs = parseDateTime(date, end);

  if (!startMs || !endMs || endMs <= startMs) {
    return "I could not understand the date or time. Use: sch RS 2026-07-13 08:00-10:00 physical Hall A";
  }

  db.prepare(`
    INSERT INTO lecture_events
    (course_id, scheduled_start, scheduled_end, status, mode, location, platform, meeting_link, created_by, created_at, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    course.id,
    startMs,
    endMs,
    status,
    modeInfo.mode,
    modeInfo.location,
    modeInfo.platform,
    modeInfo.meetingLink,
    msg.senderId,
    Date.now(),
    status === "scheduled" ? Date.now() : null
  );

  if (status === "tentative") {
    return `Noted, sir. ${course.alias} is saved as tentative for ${formatTimeRange(startMs, endMs)}.\nMode: ${modeInfo.mode === "physical" ? `Physical - ${modeInfo.location}` : `Online - ${modeInfo.platform}`}\nI will remind you 2 days before if it is still not confirmed.`;
  }

  return {
    reply: `Done, sir. ${course.alias} - ${course.name} scheduled for ${formatTimeRange(startMs, endMs)}.\nMode: ${modeInfo.mode === "physical" ? `Physical - ${modeInfo.location}` : `Online - ${modeInfo.platform}`}`,
    broadcasts: [
      {
        chatId: config.chats.bsc,
        message: buildConfirmedBroadcast(course, {
          scheduled_start: startMs,
          scheduled_end: endMs,
          mode: modeInfo.mode,
          location: modeInfo.location,
          platform: modeInfo.platform,
        }),
      },
      {
        chatId: config.chats.bscBcs,
        message: buildConfirmedBroadcast(course, {
          scheduled_start: startMs,
          scheduled_end: endMs,
          mode: modeInfo.mode,
          location: modeInfo.location,
          platform: modeInfo.platform,
        }),
      },
    ],
  };
}

function buildConfirmedBroadcast(course, event) {
  return `⭕⭕ \nLecture confirmed\n${course.alias} - ${course.name}\n${formatTimeRange(event.scheduled_start, event.scheduled_end)}\nMode: ${describeMode(event)}`;
}

function findTentativeLecture(courseId, dateText, optionalStartTime = null) {
  const { start, end } = getDayRange(dateText);

  let rows;

  if (optionalStartTime) {
    const startMs = parseDateTime(dateText, optionalStartTime);

    rows = db.prepare(`
      SELECT *
      FROM lecture_events
      WHERE course_id = ?
        AND scheduled_start = ?
        AND status = 'tentative'
      ORDER BY scheduled_start ASC
    `).all(courseId, startMs);
  } else {
    rows = db.prepare(`
      SELECT *
      FROM lecture_events
      WHERE course_id = ?
        AND scheduled_start BETWEEN ? AND ?
        AND status = 'tentative'
      ORDER BY scheduled_start ASC
    `).all(courseId, start, end);
  }

  return rows;
}

function confirmTentative(msg, match) {
  if (!guardrails.isOwner(msg.senderId)) {
    return "Only Sir can confirm tentative lectures.";
  }

  const alias = match[1].toUpperCase();
  const date = match[2];
  const optionalStartTime = match[3] || null;
  const modeRaw = match[4];
  const detailRaw = match[5];

  const course = getCourse(alias);

  if (!course) {
    return `I could not find subject "${alias}".`;
  }

  const modeInfo = parseMode(modeRaw, detailRaw);

  if (modeInfo.error) {
    return modeInfo.error;
  }

  const rows = findTentativeLecture(course.id, date, optionalStartTime);

  if (rows.length === 0) {
    return `I could not find a tentative ${course.alias} lecture on ${date}.`;
  }

  if (rows.length > 1) {
    const options = rows.map((row) => {
      const time = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Colombo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(row.scheduled_start));

      return `- ${course.alias} ${date} ${time}`;
    });

    return `I found more than one tentative ${course.alias} lecture on ${date}. Please include the start time.\n${options.join("\n")}`;
  }

  const event = rows[0];

  db.prepare(`
    UPDATE lecture_events
    SET status = 'scheduled',
        mode = ?,
        location = ?,
        platform = ?,
        meeting_link = ?,
        confirmed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    modeInfo.mode,
    modeInfo.location,
    modeInfo.platform,
    modeInfo.meetingLink,
    Date.now(),
    Date.now(),
    event.id
  );

  const updatedEvent = {
    ...event,
    status: "scheduled",
    mode: modeInfo.mode,
    location: modeInfo.location,
    platform: modeInfo.platform,
  };

  return {
    reply: `Confirmed, sir. ${course.alias} is now recorded as a confirmed lecture.`,
    broadcasts: [
      {
        chatId: config.chats.bsc,
        message: buildConfirmedBroadcast(course, updatedEvent),
      },
      {
        chatId: config.chats.bscBcs,
        message: buildConfirmedBroadcast(course, updatedEvent),
      },
    ],
  };
}

function cancelTentative(msg, match) {
  if (!guardrails.isOwner(msg.senderId)) {
    return "Only Sir can cancel tentative lectures.";
  }

  const alias = match[1].trim();
  const date = match[2];
  const optionalStartTime = match[3] || null;
  const reason = match[4] || "No reason given";

  const course = getCourse(alias);

  if (!course) {
    return `I could not find subject "${alias}".`;
  }

  const rows = getLectureRowsByDate({
    courseId: course.id,
    dateText: date,
    status: "tentative",
    optionalStartTime,
  });

  const selected = selectSingleLectureOrAsk(rows, course, date, "tentative");

  if (selected.error) {
    return selected.error;
  }

  const event = selected.event;

  recordLectureHistory({
    lectureId: event.id,
    courseId: course.id,
    action: "tentative_deleted",
    oldEvent: event,
    newEvent: null,
    reason,
    performedBy: msg.senderId,
  });

  db.prepare(`
    DELETE FROM lecture_events
    WHERE id = ?
      AND status = 'tentative'
  `).run(event.id);

  return (
    `Removed, sir. Tentative ${course.alias} was deleted.\n` +
    `${formatTimeRange(event.scheduled_start, event.scheduled_end)}\n` +
    `Reason: ${reason}`
  );
}

function lectureHours(match) {
  const alias = match[2].toUpperCase();
  const course = getCourse(alias);

  if (!course) {
    return `I could not find subject "${alias}".`;
  }

  const rows = db.prepare(`
    SELECT scheduled_start, scheduled_end
    FROM lecture_events
    WHERE course_id = ?
      AND status = 'scheduled'
  `).all(course.id);

  const totalMs = rows.reduce((sum, row) => sum + (row.scheduled_end - row.scheduled_start), 0);
  const hours = totalMs / (1000 * 60 * 60);

  return `${course.alias} - ${course.name}\nConfirmed lectures recorded: ${rows.length}\nTotal confirmed hours: ${hours.toFixed(1)}`;
}

function pendingLectures(msg) {
  if (!guardrails.isOwner(msg.senderId)) {
    return "Only Sir can view tentative lectures.";
  }

  const rows = db.prepare(`
    SELECT le.*, c.alias, c.name
    FROM lecture_events le
    JOIN courses c ON c.id = le.course_id
    WHERE le.status = 'tentative'
    ORDER BY le.scheduled_start ASC
  `).all();

  if (rows.length === 0) {
    return "No tentative lectures pending.";
  }

  const lines = rows.map((row) => {
    return `- ${row.alias} - ${row.name}: ${formatTimeRange(row.scheduled_start, row.scheduled_end)} | ${describeMode(row)}`;
  });

  return `Tentative lectures pending:\n${lines.join("\n")}`;
}

function getColomboDateText(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getRangeForToday() {
  const today = getColomboDateText();
  return getDayRange(today);
}

function getRangeForTomorrow() {
  const today = getColomboDateText();
  const todayStart = new Date(`${today}T00:00:00${TZ_OFFSET}`).getTime();

  const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;
  const tomorrowEnd = tomorrowStart + 24 * 60 * 60 * 1000 - 1;

  return {
    start: tomorrowStart,
    end: tomorrowEnd,
  };
}

function getColomboDateInfo(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const weekdayText = get("weekday");

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    dateText: `${year}-${month}-${day}`,
    weekday: weekdayMap[weekdayText],
  };
}

function getRangeForThisWeek() {
  const { dateText, weekday } = getColomboDateInfo();

  const todayStart = new Date(`${dateText}T00:00:00${TZ_OFFSET}`).getTime();

  // Week starts Monday.
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;

  const start = todayStart + diffToMonday * 24 * 60 * 60 * 1000;
  const end = start + 7 * 24 * 60 * 60 * 1000 - 1;

  return { start, end };
}

function getRangeForNextWeek() {
  const thisWeek = getRangeForThisWeek();

  return {
    start: thisWeek.start + 7 * 24 * 60 * 60 * 1000,
    end: thisWeek.end + 7 * 24 * 60 * 60 * 1000,
  };
}

function listConfirmedLectures(title, startMs, endMs) {
  const rows = db.prepare(`
    SELECT le.*, c.alias, c.name
    FROM lecture_events le
    JOIN courses c ON c.id = le.course_id
    WHERE le.status = 'scheduled'
      AND le.scheduled_start BETWEEN ? AND ?
    ORDER BY le.scheduled_start ASC
  `).all(startMs, endMs);

  if (rows.length === 0) {
    return `${title}\nNo confirmed lectures found.`;
  }

  const lines = rows.map((row) => {
    return `- ${row.alias} - ${row.name}\n  ${formatTimeRange(row.scheduled_start, row.scheduled_end)}\n  Mode: ${describeMode(row)}`;
  });

  return `${title}\n${lines.join("\n")}`;
}

function recordLectureHistory({
  lectureId,
  courseId,
  action,
  oldEvent = null,
  newEvent = null,
  reason = null,
  performedBy = null,
}) {
  db.prepare(`
    INSERT INTO lecture_history
    (
      lecture_id,
      course_id,
      action,

      old_start,
      old_end,
      old_status,
      old_mode,
      old_location,
      old_platform,

      new_start,
      new_end,
      new_status,
      new_mode,
      new_location,
      new_platform,

      reason,
      performed_by,
      performed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    lectureId,
    courseId,
    action,

    oldEvent?.scheduled_start || null,
    oldEvent?.scheduled_end || null,
    oldEvent?.status || null,
    oldEvent?.mode || null,
    oldEvent?.location || null,
    oldEvent?.platform || null,

    newEvent?.scheduled_start || null,
    newEvent?.scheduled_end || null,
    newEvent?.status || null,
    newEvent?.mode || null,
    newEvent?.location || null,
    newEvent?.platform || null,

    reason,
    performedBy,
    Date.now()
  );
}

function getLectureRowsByDate({ courseId, dateText, status, optionalStartTime = null }) {
  const { start, end } = getDayRange(dateText);

  if (optionalStartTime) {
    const startMs = parseDateTime(dateText, optionalStartTime);

    return db.prepare(`
      SELECT *
      FROM lecture_events
      WHERE course_id = ?
        AND scheduled_start = ?
        AND status = ?
      ORDER BY scheduled_start ASC
    `).all(courseId, startMs, status);
  }

  return db.prepare(`
    SELECT *
    FROM lecture_events
    WHERE course_id = ?
      AND scheduled_start BETWEEN ? AND ?
      AND status = ?
    ORDER BY scheduled_start ASC
  `).all(courseId, start, end, status);
}

function buildCancelledBroadcast(course, event, reason) {
  return (
    `@all\n` +
    `Lecture cancelled\n` +
    `${course.alias} - ${course.name}\n` +
    `${formatTimeRange(event.scheduled_start, event.scheduled_end)}\n` +
    `Mode: ${describeMode(event)}\n` +
    `Reason: ${reason || "No reason given"}`
  );
}

function buildRescheduledBroadcast(course, oldEvent, newEvent, reason) {
  return (
    `⭕⭕\n` +
    `Lecture rescheduled\n` +
    `${course.alias} - ${course.name}\n\n` +
    `Old:\n` +
    `${formatTimeRange(oldEvent.scheduled_start, oldEvent.scheduled_end)}\n` +
    `Mode: ${describeMode(oldEvent)}\n\n` +
    `New:\n` +
    `${formatTimeRange(newEvent.scheduled_start, newEvent.scheduled_end)}\n` +
    `Mode: ${describeMode(newEvent)}\n` +
    `Reason: ${reason || "No reason given"}`
  );
}

function selectSingleLectureOrAsk(rows, course, date, statusLabel) {
  if (rows.length === 0) {
    return {
      error: `I could not find a ${statusLabel} ${course.alias} lecture on ${date}.`,
    };
  }

  if (rows.length > 1) {
    const options = rows.map((row) => {
      const time = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Colombo",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(new Date(row.scheduled_start));

      return `- ${course.alias} ${date} ${time}`;
    });

    return {
      error:
        `I found more than one ${statusLabel} ${course.alias} lecture on ${date}. ` +
        `Please include the start time.\n${options.join("\n")}`,
    };
  }

  return { event: rows[0] };
}

function cancelConfirmedLecture(msg, match) {
  if (!guardrails.isOwner(msg.senderId)) {
    return "Only Sir can cancel confirmed lectures.";
  }

  const alias = match[1].trim();
  const date = match[2];
  const optionalStartTime = match[3] || null;
  const reason = match[4] || "No reason given";

  const course = getCourse(alias);

  if (!course) {
    return `I could not find subject "${alias}".`;
  }

  const rows = getLectureRowsByDate({
    courseId: course.id,
    dateText: date,
    status: "scheduled",
    optionalStartTime,
  });

  const selected = selectSingleLectureOrAsk(rows, course, date, "confirmed");

  if (selected.error) {
    return selected.error;
  }

  const event = selected.event;

  db.prepare(`
    UPDATE lecture_events
    SET status = 'cancelled',
        cancel_reason = ?,
        cancelled_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(reason, Date.now(), Date.now(), event.id);

  const cancelledEvent = {
    ...event,
    status: "cancelled",
    cancel_reason: reason,
    cancelled_at: Date.now(),
  };

  recordLectureHistory({
    lectureId: event.id,
    courseId: course.id,
    action: "cancelled",
    oldEvent: event,
    newEvent: cancelledEvent,
    reason,
    performedBy: msg.senderId,
  });

  return {
    reply: `Cancelled, sir. ${course.alias} lecture has been marked as cancelled.`,
    broadcasts: [
      {
        chatId: config.chats.bsc,
        message: buildCancelledBroadcast(course, event, reason),
      },
      {
        chatId: config.chats.bscBcs,
        message: buildCancelledBroadcast(course, event, reason),
      },
    ],
  };
}

function rescheduleConfirmedLecture(msg, match) {
  if (!guardrails.isOwner(msg.senderId)) {
    return "Only Sir can reschedule confirmed lectures.";
  }

  const alias = match[1].trim();
  const oldDate = match[2];
  const optionalOldStartTime = match[3] || null;
  const newDate = match[4];
  const newStart = match[5];
  const newEnd = match[6];
  const modeRaw = match[7];
  const detailRaw = match[8];
  const reason = match[9] || "No reason given";

  const course = getCourse(alias);

  if (!course) {
    return `I could not find subject "${alias}".`;
  }

  const modeInfo = parseMode(modeRaw, detailRaw);

  if (modeInfo.error) {
    return modeInfo.error;
  }

  const rows = getLectureRowsByDate({
    courseId: course.id,
    dateText: oldDate,
    status: "scheduled",
    optionalStartTime: optionalOldStartTime,
  });

  const selected = selectSingleLectureOrAsk(rows, course, oldDate, "confirmed");

  if (selected.error) {
    return selected.error;
  }

  const oldEvent = selected.event;

  const newStartMs = parseDateTime(newDate, newStart);
  const newEndMs = parseDateTime(newDate, newEnd);

  if (!newStartMs || !newEndMs || newEndMs <= newStartMs) {
    return "I could not understand the new date or time. Use: reschedule RS 2026-07-20 to 2026-07-21 08:00-10:00 physical Hall A reason: lecturer unavailable";
  }

  const duplicate = db.prepare(`
    SELECT id
    FROM lecture_events
    WHERE course_id = ?
      AND scheduled_start = ?
      AND scheduled_end = ?
      AND status = 'scheduled'
      AND id != ?
    LIMIT 1
  `).get(course.id, newStartMs, newEndMs, oldEvent.id);

  if (duplicate) {
    return `${course.alias} is already recorded for ${formatTimeRange(newStartMs, newEndMs)}.`;
  }

  db.prepare(`
    UPDATE lecture_events
    SET scheduled_start = ?,
        scheduled_end = ?,
        mode = ?,
        location = ?,
        platform = ?,
        meeting_link = ?,
        reschedule_reason = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    newStartMs,
    newEndMs,
    modeInfo.mode,
    modeInfo.location,
    modeInfo.platform,
    modeInfo.meetingLink,
    reason,
    Date.now(),
    oldEvent.id
  );

  const newEvent = {
    ...oldEvent,
    scheduled_start: newStartMs,
    scheduled_end: newEndMs,
    mode: modeInfo.mode,
    location: modeInfo.location,
    platform: modeInfo.platform,
    meeting_link: modeInfo.meetingLink,
    reschedule_reason: reason,
  };

  recordLectureHistory({
    lectureId: oldEvent.id,
    courseId: course.id,
    action: "rescheduled",
    oldEvent,
    newEvent,
    reason,
    performedBy: msg.senderId,
  });

  return {
    reply: `Rescheduled, sir. ${course.alias} lecture has been updated.`,
    broadcasts: [
      {
        chatId: config.chats.bsc,
        message: buildRescheduledBroadcast(course, oldEvent, newEvent, reason),
      },
      {
        chatId: config.chats.bscBcs,
        message: buildRescheduledBroadcast(course, oldEvent, newEvent, reason),
      },
    ],
  };
}

function rescheduleTentativeLecture(msg, match) {
  if (!guardrails.isOwner(msg.senderId)) {
    return "Only Sir can reschedule tentative lectures.";
  }

  const alias = match[1].trim();
  const oldDate = match[2];
  const optionalOldStartTime = match[3] || null;
  const newDate = match[4];
  const newStart = match[5];
  const newEnd = match[6];
  const modeRaw = match[7];
  const detailRaw = match[8];
  const reason = match[9] || "No reason given";

  const course = getCourse(alias);

  if (!course) {
    return `I could not find subject "${alias}".`;
  }

  const modeInfo = parseMode(modeRaw, detailRaw);

  if (modeInfo.error) {
    return modeInfo.error;
  }

  const rows = getLectureRowsByDate({
    courseId: course.id,
    dateText: oldDate,
    status: "tentative",
    optionalStartTime: optionalOldStartTime,
  });

  const selected = selectSingleLectureOrAsk(rows, course, oldDate, "tentative");

  if (selected.error) {
    return selected.error;
  }

  const oldEvent = selected.event;

  const newStartMs = parseDateTime(newDate, newStart);
  const newEndMs = parseDateTime(newDate, newEnd);

  if (!newStartMs || !newEndMs || newEndMs <= newStartMs) {
    return "I could not understand the new date or time. Use: resch-tent RS 2026-07-20 to 2026-07-21 08:00-10:00 physical Hall A reason: lecturer unavailable";
  }

  db.prepare(`
    UPDATE lecture_events
    SET scheduled_start = ?,
        scheduled_end = ?,
        mode = ?,
        location = ?,
        platform = ?,
        meeting_link = ?,
        reschedule_reason = ?,
        tentative_reminder_sent_at = NULL,
        updated_at = ?
    WHERE id = ?
      AND status = 'tentative'
  `).run(
    newStartMs,
    newEndMs,
    modeInfo.mode,
    modeInfo.location,
    modeInfo.platform,
    modeInfo.meetingLink,
    reason,
    Date.now(),
    oldEvent.id
  );

  const newEvent = {
    ...oldEvent,
    scheduled_start: newStartMs,
    scheduled_end: newEndMs,
    mode: modeInfo.mode,
    location: modeInfo.location,
    platform: modeInfo.platform,
    meeting_link: modeInfo.meetingLink,
    reschedule_reason: reason,
  };

  recordLectureHistory({
    lectureId: oldEvent.id,
    courseId: course.id,
    action: "tentative_rescheduled",
    oldEvent,
    newEvent,
    reason,
    performedBy: msg.senderId,
  });

  return (
    `Rescheduled tentative lecture, sir.\n` +
    `${course.alias} - ${course.name}\n\n` +
    `Old:\n${formatTimeRange(oldEvent.scheduled_start, oldEvent.scheduled_end)}\n\n` +
    `New:\n${formatTimeRange(newStartMs, newEndMs)}\n` +
    `Mode: ${describeMode(newEvent)}\n` +
    `Reason: ${reason}`
  );
}

function handleLectureCommand(msg) {
  const text = cleanText(msg.text);

  const createMatch = text.match(/^(schedule|sch|tentative|tent)\s+([a-zA-Z]+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\s+(online|physical)\s+(.+)$/i);

  if (createMatch) {
    const command = createMatch[1].toLowerCase();
    const status = command === "tentative" || command === "tent" ? "tentative" : "scheduled";
    return createLecture(msg, createMatch, status);
  }

  const confirmMatch = text.match(/^confirm\s+([a-zA-Z]+)\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s+(online|physical)\s+(.+)$/i);

  if (confirmMatch) {
    return confirmTentative(msg, confirmMatch);
  }

  const hoursMatch = text.match(/^(hours|count)\s+([a-zA-Z]+)$/i);

  if (hoursMatch) {
    return lectureHours(hoursMatch);
  }

  if (/^pending lectures$/i.test(text) || /^pending$/i.test(text)) {
    return pendingLectures(msg);
  }

  if (/^(today|today lectures|lectures today)$/i.test(text)) {
    const { start, end } = getRangeForToday();
    return listConfirmedLectures("Today's confirmed lectures:", start, end);
  }
  
  if (/^(tomorrow|tomorrow lectures|lectures tomorrow)$/i.test(text)) {
    const { start, end } = getRangeForTomorrow();
    return listConfirmedLectures("Tomorrow's confirmed lectures:", start, end);
  }
  
  if (/^(this week|this week lectures|lectures this week|lecture schedule)$/i.test(text)) {
    return listThisWeekLecturesSmart();
  }
  
  if (/^(next week|next week lectures|lectures next week)$/i.test(text)) {
    const { start, end } = getRangeForNextWeek();
    return listConfirmedLectures("Next week's confirmed lectures:", start, end);
  }
  
  const lower = text.toLowerCase();
  
  if (
    lower.includes("lecture") ||
    lower.includes("lectures") ||
    lower.includes("scheduled") ||
    lower.includes("schedule")
  ) {
    if (lower.includes("today")) {
      const { start, end } = getRangeForToday();
      return listConfirmedLectures("Today's confirmed lectures:", start, end);
    }
  
    if (lower.includes("tomorrow")) {
      const { start, end } = getRangeForTomorrow();
      return listConfirmedLectures("Tomorrow's confirmed lectures:", start, end);
    }
  
    if (lower.includes("this week")) {
      return listThisWeekLecturesSmart();
    }
    
    if (lower.includes("next week")) {
      const { start, end } = getRangeForNextWeek();
      return listConfirmedLectures("Next week's confirmed lectures:", start, end);
    }
  }
  
  const rescheduleConfirmedMatch = text.match(
    /^res(?:chedule|ch)\s+(.+?)\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s+to\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\s+(online|physical)\s+(.+?)(?:\s+reason:\s*(.+))?$/i
  );
  
  if (rescheduleConfirmedMatch) {
    return rescheduleConfirmedLecture(msg, rescheduleConfirmedMatch);
  }
  
  const rescheduleTentMatch = text.match(
    /^resch-tent\s+(.+?)\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s+to\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\s+(online|physical)\s+(.+?)(?:\s+reason:\s*(.+))?$/i
  );
  
  if (rescheduleTentMatch) {
    return rescheduleTentativeLecture(msg, rescheduleTentMatch);
  }
  
  const cancelConfirmedMatch = text.match(
    /^cancel\s+(.+?)\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?(?:\s+reason:\s*(.+))?$/i
  );
  
  if (cancelConfirmedMatch) {
    return cancelConfirmedLecture(msg, cancelConfirmedMatch);
  }
  
  const cancelTentMatch = text.match(
    /^cancel-tent\s+(.+?)\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?(?:\s+reason:\s*(.+))?$/i
  );
  
  if (cancelTentMatch) {
    return cancelTentative(msg, cancelTentMatch);
  }
  
  return null;
}

function checkTentativeReminders() {
  const now = Date.now();
  const twoDaysFromNow = now + 48 * 60 * 60 * 1000;

  const rows = db.prepare(`
    SELECT le.*, c.alias, c.name
    FROM lecture_events le
    JOIN courses c ON c.id = le.course_id
    WHERE le.status = 'tentative'
      AND le.scheduled_start <= ?
      AND le.scheduled_start > ?
      AND le.tentative_reminder_sent_at IS NULL
    ORDER BY le.scheduled_start ASC
  `).all(twoDaysFromNow, now);

  for (const row of rows) {
    const dateText = formatDateOnly(row.scheduled_start);

    const message =
      `Sir, this lecture is still tentative.\n` +
      `${row.alias} - ${row.name}\n` +
      `${formatTimeRange(row.scheduled_start, row.scheduled_end)}\n` +
      `Mode: ${describeMode(row)}\n\n` +
      `If confirmed, reply:\n` +
      `@Lily confirm ${row.alias} ${dateText} ${row.mode === "physical" ? "physical HallName" : "online Zoom"}\n\n` +
      `If not confirmed, reply:\n` +
      `@Lily cancel-tent ${row.alias} ${dateText} reason: not confirmed`;

    outboundQueue.enqueueMessage({
      chatId: config.owner.waId,
      message,
    });

    db.prepare(`
      UPDATE lecture_events
      SET tentative_reminder_sent_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(Date.now(), Date.now(), row.id);

    logger.info("lecture", "Tentative lecture reminder queued", {
      lectureId: row.id,
      alias: row.alias,
    });
  }
}

function cleanupExpiredTentatives() {
  const result = db.prepare(`
    DELETE FROM lecture_events
    WHERE status = 'tentative'
      AND scheduled_end < ?
  `).run(Date.now());

  if (result.changes > 0) {
    logger.info("lecture", "Expired tentative lectures deleted", {
      count: result.changes,
    });
  }
}

function runTentativeMaintenance() {
  try {
    checkTentativeReminders();
    cleanupExpiredTentatives();
  } catch (err) {
    logger.error("lecture", "Tentative maintenance failed", {
      error: err.message,
    });
  }
}

function startLectureScheduler() {
  cron.schedule("*/30 * * * *", runTentativeMaintenance);

  setTimeout(runTentativeMaintenance, 5000);

  logger.info("lecture", "Lecture scheduler started");
}

function getColomboDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    weekday: get("weekday"),
    hour: get("hour"),
    minute: get("minute"),
    dateText: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function addDaysToDateText(dateText, days) {
  const base = new Date(`${dateText}T00:00:00${TZ_OFFSET}`).getTime();
  const target = new Date(base + days * 24 * 60 * 60 * 1000);

  const parts = getColomboDateParts(target);

  return parts.dateText;
}

function getCurrentScheduleDateContext() {
  const today = getColomboDateParts();
  const tomorrowDateText = addDaysToDateText(today.dateText, 1);
  const tomorrow = getColomboDateParts(
    new Date(`${tomorrowDateText}T12:00:00${TZ_OFFSET}`)
  );

  return {
    todayDate: today.dateText,
    todayWeekday: today.weekday,
    currentTime: `${today.hour}:${today.minute}`,
    tomorrowDate: tomorrow.dateText,
    tomorrowWeekday: tomorrow.weekday,
  };
}

function getConfirmedLectureContextForAI() {
  const dateContext = getCurrentScheduleDateContext();

  // Start from today 00:00 Sri Lanka time, not Date.now().
  // This prevents AI missing today's lectures that already started.
  const startToday = new Date(`${dateContext.todayDate}T00:00:00${TZ_OFFSET}`).getTime();
  const next14Days = startToday + 14 * 24 * 60 * 60 * 1000;

  const rows = db.prepare(`
    SELECT le.*, c.alias, c.name
    FROM lecture_events le
    JOIN courses c ON c.id = le.course_id
    WHERE le.status = 'scheduled'
      AND le.scheduled_start BETWEEN ? AND ?
    ORDER BY le.scheduled_start ASC
  `).all(startToday, next14Days);

  const header =
    `Current Sri Lanka date/time:\n` +
    `Today: ${dateContext.todayWeekday}, ${dateContext.todayDate}, ${dateContext.currentTime}\n` +
    `Tomorrow: ${dateContext.tomorrowWeekday}, ${dateContext.tomorrowDate}\n`;

  if (rows.length === 0) {
    return header + "\nNo confirmed lectures are recorded for the next 14 days.";
  }

  const lines = rows.map((row) => {
    const dateParts = getColomboDateParts(new Date(row.scheduled_start));

    return (
      `${dateParts.dateText} ${dateParts.weekday} | ` +
      `${row.alias} - ${row.name} | ` +
      `${formatTimeRange(row.scheduled_start, row.scheduled_end)} | ` +
      `${describeMode(row)}`
    );
  });

  return header + "\nConfirmed lectures for the next 14 days:\n" + lines.join("\n");
}

module.exports = {
  handleLectureCommand,
  startLectureScheduler,
  getConfirmedLectureContextForAI,
};
