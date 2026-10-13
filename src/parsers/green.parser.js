function getText(messageData) {
  if (!messageData) return "";

  if (messageData.typeMessage === "textMessage") {
    return messageData.textMessageData?.textMessage || "";
  }

  if (
    messageData.typeMessage === "extendedTextMessage" ||
    messageData.typeMessage === "quotedMessage"
  ) {
    return messageData.extendedTextMessageData?.text || "";
  }

  if (
    messageData.typeMessage === "imageMessage" ||
    messageData.typeMessage === "documentMessage"
  ) {
    return messageData.fileMessageData?.caption || "";
  }

  return "";
}

function getQuotedInfo(messageData) {
  const extended = messageData?.extendedTextMessageData;

  const quotedMessage = messageData?.quotedMessage;

  return {
    quotedWaId: extended?.stanzaId || quotedMessage?.stanzaId || null,
    quotedParticipant: extended?.participant || quotedMessage?.participant || null,
    quotedText:
      quotedMessage?.textMessage ||
      quotedMessage?.extendedTextMessageData?.text ||
      quotedMessage?.caption ||
      null,
  };
}

function parseGreenMessage(body) {
  const senderData = body.senderData || {};
  const messageData = body.messageData || {};

  const text = getText(messageData);
  const quoted = getQuotedInfo(messageData);

  return {
    raw: body,

    typeWebhook: body.typeWebhook,
    chatId: senderData.chatId,
    senderId: senderData.sender,
    senderName: senderData.senderName || "Unknown",

    waMessageId: body.idMessage,
    timestamp: body.timestamp ? body.timestamp * 1000 : Date.now(),

    typeMessage: messageData.typeMessage,
    text,

    quotedWaId: quoted.quotedWaId,
    quotedParticipant: quoted.quotedParticipant,
    quotedText: quoted.quotedText,

    mentionedJid:
      messageData.extendedTextMessageData?.mentionedJid ||
      messageData.textMessageData?.mentionedJid ||
      [],
  };
}

module.exports = {
  parseGreenMessage,
};
