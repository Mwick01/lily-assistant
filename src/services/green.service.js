const axios = require("axios");
const config = require("../config");

const baseUrl = `https://7107.api.green-api.com/waInstance${config.greenApi.idInstance}`;

async function sendMessage({ chatId, message, quotedMessageId = null }) {
  const url = `${baseUrl}/sendMessage/${config.greenApi.token}`;

  const payload = {
    chatId,
    message,
  };

  if (quotedMessageId) {
    payload.quotedMessageId = quotedMessageId;
  }

  const response = await axios.post(url, payload, {
    timeout: 15000,
  });

  return response.data;
}

module.exports = {
  sendMessage,
};
