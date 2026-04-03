const { query } = require("../database/db");

const MESSAGE_TEMPLATE_KEY = "message_template";

async function getSetting(key) {
  const { rows } = await query("SELECT value FROM app_settings WHERE key = $1", [key]);
  return rows[0]?.value || "";
}

async function setSetting(key, value) {
  const { rows } = await query(
    "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() RETURNING value",
    [key, value]
  );
  return rows[0]?.value || "";
}

async function getMessageTemplate() {
  return getSetting(MESSAGE_TEMPLATE_KEY);
}

async function setMessageTemplate(template) {
  return setSetting(MESSAGE_TEMPLATE_KEY, template);
}

module.exports = {
  getSetting,
  setSetting,
  getMessageTemplate,
  setMessageTemplate,
  MESSAGE_TEMPLATE_KEY,
};
