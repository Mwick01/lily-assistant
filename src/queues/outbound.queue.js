const db = require("../db");
const green = require("../services/green.service");
const logger = require("../services/logger.service");

let isProcessing = false;

function enqueueMessage({
  chatId,
  message,
  quotedMessageId = null,
  threadId = null,
  storeAsAssistant = false,
}) {
  db.prepare(`
    INSERT INTO outbound_queue
    (
      chat_id,
      message,
      quoted_message_id,
      status,
      attempts,
      created_at,
      thread_id,
      store_as_assistant
    )
    VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(
    chatId,
    message,
    quotedMessageId,
    Date.now(),
    threadId,
    storeAsAssistant ? 1 : 0
  );

  processQueue();
}

async function processQueue() {
  if (isProcessing) return;

  isProcessing = true;

  try {
    while (true) {
      const job = db.prepare(`
        SELECT *
        FROM outbound_queue
        WHERE status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      `).get();

      if (!job) break;

      db.prepare(`
        UPDATE outbound_queue
        SET status = 'sending',
            attempts = attempts + 1
        WHERE id = ?
      `).run(job.id);

      try {
        const sent = await green.sendMessage({
          chatId: job.chat_id,
          message: job.message,
          quotedMessageId: job.quoted_message_id,
        });

        db.prepare(`
          UPDATE outbound_queue
          SET status = 'sent',
              sent_at = ?
          WHERE id = ?
        `).run(Date.now(), job.id);

        logger.info("outbound_queue", "Message sent", {
          jobId: job.id,
          sent,
        });

        if (job.store_as_assistant && job.thread_id && sent.idMessage) {
          db.prepare(`
            INSERT OR IGNORE INTO thread_messages
            (thread_id, chat_id, wa_message_id, role, text, created_at)
            VALUES (?, ?, ?, 'assistant', ?, ?)
          `).run(
            job.thread_id,
            job.chat_id,
            sent.idMessage,
            job.message,
            Date.now()
          );

          logger.info("outbound_queue", "Assistant message stored", {
            threadId: job.thread_id,
            waMessageId: sent.idMessage,
          });
        }
      } catch (err) {
        logger.error("outbound_queue", "Failed to send message", {
          jobId: job.id,
          error: err.message,
          status: err.response?.status,
          data: err.response?.data,
        });

        const nextStatus = job.attempts + 1 >= 3 ? "failed" : "pending";

        db.prepare(`
          UPDATE outbound_queue
          SET status = ?,
              error = ?
          WHERE id = ?
        `).run(nextStatus, err.message, job.id);

        break;
      }
    }
  } finally {
    isProcessing = false;
  }
}

setInterval(processQueue, 5000);

module.exports = {
  enqueueMessage,
  processQueue,
};
