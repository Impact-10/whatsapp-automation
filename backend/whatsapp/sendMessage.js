async function sendWhatsAppMessage(whatsAppClient, phone, message) {
  return whatsAppClient.sendMessage(phone, message);
}

module.exports = {
  sendWhatsAppMessage,
};
