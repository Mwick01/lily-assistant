const db = require("../db");
const config = require("../config");

function getState(chatId) {
  let state = db.prepare(`
    SELECT * FROM guardrail_state WHERE chat_id = ?
  `).get(chatId);

  if (!state) {
    db.prepare(`
      INSERT INTO guardrail_state
      (chat_id, active_reading_enabled, reply_mode, no_reply_until, updated_at)
      VALUES (?, 1, 'all', 0, ?)
    `).run(chatId, Date.now());

    state = db.prepare(`
      SELECT * FROM guardrail_state WHERE chat_id = ?
    `).get(chatId);
  }

  return state;
}

function isOwner(senderId) {
  return senderId === config.owner.waId;
}

function isGuardrailCommand(text) {
  return text && text.includes("-tb") || text.includes("-AR") || text.includes("-NRD") || text.includes("-NRP") || text.includes("-RS") || text.includes("-RP");
}

function applyGuardrailCommand(msg) {
  if (!isOwner(msg.senderId)) {
    return {
      allowed: false,
      response: "Only Sir can change my operating mode.",
    };
  }

  const state = getState(msg.chatId);

  let activeReading = state.active_reading_enabled;
  let replyMode = state.reply_mode;
  let noReplyUntil = state.no_reply_until || 0;

  const text = msg.text;

  if (text.includes("-AR")) {
    activeReading = 1;
  }

  if (text.includes("-NRD")) {
    activeReading = 0;
  }

  if (text.includes("-NRP")) {
    replyMode = "none";
  }

  if (text.includes("-RS")) {
    replyMode = "owner_only";
  }

  if (text.includes("-RP")) {
    replyMode = "all";
    noReplyUntil = 0;
  }

  const tbMatch = text.match(/-tb\s+(\d+)/i);
  if (tbMatch) {
    const seconds = Number(tbMatch[1]);
    noReplyUntil = Date.now() + seconds * 1000;
  }

  db.prepare(`
    UPDATE guardrail_state
    SET active_reading_enabled = ?,
        reply_mode = ?,
        no_reply_until = ?,
        updated_by = ?,
        updated_at = ?
    WHERE chat_id = ?
  `).run(
    activeReading,
    replyMode,
    noReplyUntil,
    msg.senderId,
    Date.now(),
    msg.chatId
  );

  return {
    allowed: true,
    response: "Understood, sir. I have updated my operating mode.",
  };
}

function canReply(msg) {
  const state = getState(msg.chatId);

  if (state.no_reply_until && Date.now() < state.no_reply_until) {
    return false;
  }

  if (state.reply_mode === "none") {
    return false;
  }

  if (state.reply_mode === "owner_only" && !isOwner(msg.senderId)) {
    return false;
  }

  return true;
}

module.exports = {
  getState,
  isOwner,
  isGuardrailCommand,
  applyGuardrailCommand,
  canReply,
};
