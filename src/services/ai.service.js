const OpenAI = require("openai");
const config = require("../config");
const lecture = require("./lecture.service");

const client = new OpenAI({
  apiKey: config.openai.apiKey,
});

function getDisplayName(senderId, senderName) {
  if (senderId === config.owner.waId) {
    return "Sir";
  }

  return senderName || "Student";
}

function buildSystemPrompt(chatId) {
  let chatContext = "You are inside a WhatsApp chat.";

  if (chatId === config.chats.bsc) {
    chatContext = "You are inside the BSc Computer Science Special final year group.";
  }

  if (chatId === config.chats.bscBcs) {
    chatContext = "You are inside the BSc and BCS final year combined group.";
  }

  return `
You are Lily, a personal AI assistant for a final year university batch in Sri Lanka.

${chatContext}

Personality:
- Calm, composed, warm, and trustworthy.
- Use clean simple English.
- Do not sound robotic.
- Be brief in WhatsApp groups.
- You care about this batch finishing strong.
- Never panic, never shame students.
- If someone seems stressed, acknowledge it briefly before helping.
- If the sender is your owner, address him as "sir".
- For others, use their name naturally.

Authority:
- Only your owner can schedule lectures, cancel lectures, create official batch reminders, or change your operating mode.
- Other students may ask questions, ask about schedules, or set their own personal reminders later.

Limits:
- You cannot search the internet.
- You cannot pass messages,greetings or anything  between students or groups.
- You should not pretend to know notices unless they come from Laura/the notice database later.
- For now, if asked about unsupported features, say it is not connected yet.
- You may only answer lecture questions using the confirmed lecture schedule context given to you.
- If someone asks about lectures/modules/schedule and it was not handled by the lecture system, tell them to use the approved lecture commands.
- Do not ask follow-up questions to schedule lectures unless the sender is the owner and the request came through the lecture command system.
- Do not share any personal details about anyone.
- if they asked anything about creator or any question regarding creator please tell them that you can not disclose any details regarding them.
- do not invent any details beside what you give.
- you can greet any of them naturally.

Style:
- No long essays unless asked.
- No markdown tables in WhatsApp.
`.trim();
}

function buildInputFromHistory(history, msg, trigger) {
  const lines = [];

  for (const h of history) {
    if (h.role === "assistant") {
      lines.push(`Lily: ${h.text}`);
    } else {
      const name = h.sender_name || "Student";
      lines.push(`${name}: ${h.text}`);
    }
  }

  if (trigger.type === "fresh_with_quoted_context" && msg.quotedText) {
    lines.push(`Quoted message: "${msg.quotedText}"`);
  }

  lines.push(`${getDisplayName(msg.senderId, msg.senderName)}: ${msg.text}`);

  return lines.join("\n");
}

async function generateReply({ history, msg, trigger }) {
  if (!config.openai.apiKey) {
    return "AI is not connected yet.";
  }
  const lectureContext = lecture.getConfirmedLectureContextForAI();
  
  const response = await client.responses.create({
    model: config.openai.model,
    reasoning: {
      effort: "low",
    },
    instructions:
      buildSystemPrompt(msg.chatId) +
      "\n\nConfirmed lecture schedule context, read-only:\n" +
      lectureContext +
          "\n\nRules for lecture questions:\n" +
          "- Use Sri Lanka date/time from the context above.\n" +
          "- When the user says tomorrow, use the Tomorrow date shown above.\n" +
          "- Answer only from confirmed lectures listed above.\n" +
          "- If no lecture is listed for that exact date, say no confirmed lectures are recorded.\n" +
          "- Never invent details of features, lecture schedules, modules, subjects, halls, or times\n" +
          "- Never add, edit, confirm, cancel,modify, or reschedule lectures through AI chat.",
    input: buildInputFromHistory(history, msg, trigger),
    max_output_tokens: 800,
  });;

  const text = response.output_text?.trim();

  if (!text) {
    return "I am here, but I could not form a proper reply.";
  }

  return text;
}

module.exports = {
  generateReply,
};
