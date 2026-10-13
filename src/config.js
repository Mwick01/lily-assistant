require("dotenv").config();

module.exports = {
  port: Number(process.env.PORT || 3000),

  bot: {
    name: process.env.BOT_NAME || "Lily",
    phone: process.env.BOT_PHONE,
    waId: process.env.BOT_WA_ID,
  },

  owner: {
    waId: process.env.OWNER_WA_ID,
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-5-nano",
  },

  greenApi: {
    apiUrl: process.env.GREEN_API_URL || "https://api.green-api.com",
    idInstance: process.env.GREEN_API_ID_INSTANCE,
    token: process.env.GREEN_API_TOKEN,
  },

  security: {
    webhookSecret: process.env.WEBHOOK_SECRET,
  },

  databasePath: process.env.DATABASE_PATH || "./data/lily.sqlite",

  chats: {
    bsc: process.env.BSC_GROUP_CHAT_ID,
    bscBcs: process.env.BSC_BCS_GROUP_CHAT_ID,
  },
};
