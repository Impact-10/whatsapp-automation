const { sendWhatsAppMessage } = require("./whatsappClient");

async function sendMessage(_client, phone, message) {
  await sendWhatsAppMessage(phone, message);
}

module.exports = {
  sendMessage,
};
