const config = require("../config");
const guardrails = require("./guardrails.service");
const chat = require("./chat.service");
const lecture = require("./lecture.service");
const ai = require("./ai.service");
const outboundQueue = require("../queues/outbound.queue");
const logger = require("./logger.service");

function cleanCommandText(text) {
  return (text || "")
    .replace(/@\d+/g, "")
    .replace(/@Lily/gi, "")
    .replace(/^lily[\s,:\-]+/i, "")
    .trim();
}

function isReactionOrEmpty(msg) {
  const text = (msg.text || "").trim();

  const alwaysIgnoreTypes = [
    "reactionMessage",
    "stickerMessage",
    "editedMessage",
    "deletedMessage",
    "pollUpdateMessage",
  ];

  if (alwaysIgnoreTypes.includes(msg.typeMessage)) {
    return true;
  }

  // Ignore empty non-text messages unless we later explicitly support them
  const textBasedTypes = [
    "textMessage",
    "extendedTextMessage",
    "quotedMessage",
  ];

  if (!text && !textBasedTypes.includes(msg.typeMessage)) {
    return true;
  }

  // Common reaction-only texts
  if (/^[👍👎😂🤣❤️💔🔥👏🙏😮😢😡✅❌⭐]+$/u.test(text)) {
    return true;
  }

  if (!text) {
    return true;
  }

  return false;
}

function looksLikeLectureCommand(text) {
  const cleaned = cleanCommandText(text);

  return /^(schedule|sch|tentative|tent|confirm|cancel|cancel-tent|reschedule|resch|resch-tent|hours|count|pending|pending lectures|lecture schedule|today lectures|tomorrow lectures|this week lectures|next week lectures|lectures today|lectures tomorrow|lectures this week|lectures next week|today|tomorrow|this week|next week)\b/i.test(cleaned);
}

function sendLectureResult(msg, lectureResult) {
  if (typeof lectureResult === "string") {
    outboundQueue.enqueueMessage({
      chatId: msg.chatId,
      message: lectureResult,
      quotedMessageId: msg.waMessageId,
    });

    return;
  }

  if (lectureResult.reply) {
    outboundQueue.enqueueMessage({
      chatId: msg.chatId,
      message: lectureResult.reply,
      quotedMessageId: msg.waMessageId,
    });
  }

  const sentChats = new Set();

  for (const item of lectureResult.broadcasts || []) {
    if (!item.chatId || sentChats.has(item.chatId)) continue;

    sentChats.add(item.chatId);

    outboundQueue.enqueueMessage({
      chatId: item.chatId,
      message: item.message,
    });
  }
}

async function routeMessage(msg) {
  if (!msg.chatId || !msg.waMessageId) {
    logger.warn("router", "Invalid message ignored", msg);
    return;
  }

  if (msg.senderId === config.bot.waId) {
    logger.info("router", "Ignored Lily's own message", {
      chatId: msg.chatId,
      waMessageId: msg.waMessageId,
    });
    return;
  }

  if (isReactionOrEmpty(msg)) {
    logger.info("router", "Ignored reaction, sticker, or empty message", {
      chatId: msg.chatId,
      senderId: msg.senderId,
      typeMessage: msg.typeMessage,
      text: msg.text,
    });
    return;
  }
  
  if (guardrails.isGuardrailCommand(msg.text || "")) {
    const result = guardrails.applyGuardrailCommand(msg);

    if (result.response) {
      outboundQueue.enqueueMessage({
        chatId: msg.chatId,
        message: result.response,
        quotedMessageId: msg.waMessageId,
      });
    }

    return;
  }

  if (!guardrails.canReply(msg)) {
    logger.info("router", "Reply blocked by guardrails", {
      chatId: msg.chatId,
      senderId: msg.senderId,
    });
    return;
  }

  const trigger = chat.classifyChatTrigger(msg);

  if (!trigger) {
    return;
  }

  logger.info("router", "Message triggered Lily", {
    trigger,
    text: msg.text,
    cleanedText: cleanCommandText(msg.text),
  });

  const lectureResult = lecture.handleLectureCommand(msg);

  logger.info("router", "Lecture command check result", {
    isLectureLike: looksLikeLectureCommand(msg.text),
    handled: Boolean(lectureResult),
    resultType: typeof lectureResult,
  });

  if (lectureResult) {
    sendLectureResult(msg, lectureResult);

    logger.info("router", "Lecture command handled", {
      chatId: msg.chatId,
      senderId: msg.senderId,
    });

    return;
  }

  if (looksLikeLectureCommand(msg.text)) {
    outboundQueue.enqueueMessage({
      chatId: msg.chatId,
      message:
        "I understood this is a lecture command, but I could not parse it.\n\n" +
        "Use examples like:\n" +
        "sch RS 2026-07-14 10:00-12:00 physical e-learning\n" +
        "tent AI 2026-07-15 13:00-15:00 online Zoom\n" +
        "confirm AI 2026-07-15 physical e-learning\n" +
        "hours RS",
      quotedMessageId: msg.waMessageId,
    });

    logger.warn("router", "Lecture-like command blocked from AI", {
      text: msg.text,
    });

    return;
  }

  chat.saveUserMessage(msg, trigger.threadId);

  const history = chat.getThreadHistory(trigger.threadId);

  let reply;

  try {
    reply = await ai.generateReply({
      history,
      msg,
      trigger,
    });
  } catch (err) {
    logger.error("router", "AI reply failed", {
      error: err.message,
    });

    reply = "I am here, but I had trouble thinking clearly for a moment. Please try again.";
  }

  outboundQueue.enqueueMessage({
    chatId: msg.chatId,
    message: reply,
    quotedMessageId: msg.waMessageId,
    threadId: trigger.threadId,
    storeAsAssistant: true,
  });

  logger.info("router", "AI chat reply queued", {
    trigger,
    chatId: msg.chatId,
    senderName: msg.senderName,
  });
}

module.exports = {
  routeMessage,
};
