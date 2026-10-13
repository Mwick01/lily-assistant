const db = require("../db");
const config = require("../config");

function wasLilyMentioned(msg) {
  const text = msg.text || "";

  const botNameRegex = new RegExp(`\\b${config.bot.name}\\b`, "i");

  const mentionedByJid =
    Array.isArray(msg.mentionedJid) &&
    msg.mentionedJid.includes(config.bot.waId);

  const mentionedByName = botNameRegex.test(text);

  const mentionedByPhone =
    config.bot.phone &&
    (
      text.includes(config.bot.phone) ||
      text.includes(`@${config.bot.phone}`)
    );

  return mentionedByJid || mentionedByName || mentionedByPhone;
}

function isDirectChat(msg) {
  return msg.chatId && msg.chatId.endsWith("@c.us");
}

function getAddressName(msg) {
  if (msg.senderId === config.owner.waId) {
    return "sir";
  }

  return msg.senderName || "there";
}

function findThreadByBotMessage(waMessageId) {
  return db.prepare(`
    SELECT thread_id
    FROM thread_messages
    WHERE wa_message_id = ?
      AND role = 'assistant'
    LIMIT 1
  `).get(waMessageId);
}

function classifyChatTrigger(msg) {
  const mentioned = wasLilyMentioned(msg);
  const directChat = isDirectChat(msg);

  if (directChat) {
    return {
      type: "direct_chat",
      threadId: `direct:${msg.chatId}`,
    };
  }

  if (msg.quotedWaId) {
    const existingThread = findThreadByBotMessage(msg.quotedWaId);

    if (existingThread) {
      return {
        type: "continue_thread",
        threadId: existingThread.thread_id,
      };
    }

    if (mentioned) {
      return {
        type: "fresh_with_quoted_context",
        threadId: msg.waMessageId,
      };
    }

    return null;
  }

  if (mentioned) {
    return {
      type: "fresh",
      threadId: msg.waMessageId,
    };
  }

  return null;
}

function saveUserMessage(msg, threadId) {
  db.prepare(`
    INSERT OR IGNORE INTO thread_messages
    (thread_id, chat_id, wa_message_id, quoted_wa_id, role, sender_id, sender_name, text, created_at)
    VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?)
  `).run(
    threadId,
    msg.chatId,
    msg.waMessageId,
    msg.quotedWaId,
    msg.senderId,
    msg.senderName,
    msg.text,
    Date.now()
  );
}

function saveAssistantMessage({ threadId, chatId, waMessageId, text }) {
  db.prepare(`
    INSERT OR IGNORE INTO thread_messages
    (thread_id, chat_id, wa_message_id, role, text, created_at)
    VALUES (?, ?, ?, 'assistant', ?, ?)
  `).run(threadId, chatId, waMessageId, text, Date.now());
}

function getThreadHistory(threadId) {
  return db.prepare(`
    SELECT role, sender_name, text
    FROM thread_messages
    WHERE thread_id = ?
    ORDER BY id ASC
    LIMIT 12
  `).all(threadId);
}

function buildTestReply(msg, trigger) {
  const name = getAddressName(msg);

  if (trigger.type === "direct_chat") {
    return `Yes ${name}, I am here. Core connection is working now.`;
  }

  if (trigger.type === "fresh_with_quoted_context") {
    return `I saw the quoted message, ${name}. I am connected and listening.`;
  }

  if (trigger.type === "continue_thread") {
    return `Yes ${name}, I am following this thread.`;
  }

  return `I am here, ${name}. Core connection is working now.`;
}

module.exports = {
  wasLilyMentioned,
  classifyChatTrigger,
  saveUserMessage,
  saveAssistantMessage,
  getThreadHistory,
  buildTestReply,
};
