const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

async function main() {
  const apiUrl = (process.env.GREEN_API_URL || "").replace(/\/+$/, "");
  const idInstance = process.env.GREEN_API_ID_INSTANCE;
  const token = process.env.GREEN_API_TOKEN;
  const chatId = process.env.BOT_WA_ID;

  if (!apiUrl || !idInstance || !token || !chatId) {
    throw new Error(
      "Missing GREEN_API_URL, GREEN_API_ID_INSTANCE, GREEN_API_TOKEN, or BOT_WA_ID in .env"
    );
  }

  const url = `${apiUrl}/waInstance${idInstance}/getAvatar/${token}`;

  const response = await axios.post(
    url,
    { chatId },
    {
      timeout: 30000,
      headers: { "Content-Type": "application/json" },
    }
  );

  const { available, urlAvatar, base64Avatar } = response.data;

  if (!available) {
    throw new Error("Avatar is not available due to privacy settings.");
  }

  if (!urlAvatar && !base64Avatar) {
    throw new Error("No profile picture is currently set.");
  }

  const outputDir = path.resolve("assets");
  const outputPath = path.join(outputDir, "lily-avatar.jpg");

  fs.mkdirSync(outputDir, { recursive: true });

  if (base64Avatar) {
    fs.writeFileSync(outputPath, Buffer.from(base64Avatar, "base64"));
  } else {
    const image = await axios.get(urlAvatar, {
      responseType: "arraybuffer",
      timeout: 30000,
    });

    fs.writeFileSync(outputPath, Buffer.from(image.data));
  }

  console.log(`Saved Lily avatar to ${outputPath}`);
}

main().catch((err) => {
  console.error(err.response?.data || err.message);
  process.exit(1);
});