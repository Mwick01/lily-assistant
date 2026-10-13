const express = require("express");
const config = require("./config");
const logger = require("./services/logger.service");
const { parseGreenMessage } = require("./parsers/green.parser");
const router = require("./services/router.service");
const lecture = require("./services/lecture.service");

const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.json({
    name: "Lily Assistant",
    status: "running",
  });
});

app.post("/webhook/green/:secret", async (req, res) => {
  if (req.params.secret !== config.security.webhookSecret) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    const msg = parseGreenMessage(req.body);

    logger.info("webhook", "Message received", {
      chatId: msg.chatId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      text: msg.text,
      typeMessage: msg.typeMessage,
      mentionedJid: msg.mentionedJid,
      quotedWaId: msg.quotedWaId,
    });

    await router.routeMessage(msg);
  } catch (err) {
    logger.error("webhook", "Webhook processing failed", {
      error: err.message,
      stack: err.stack,
    });
  }
});

app.listen(config.port, () => {
  logger.info("server", `Lily is running on port ${config.port}`);
  lecture.startLectureScheduler();
});
