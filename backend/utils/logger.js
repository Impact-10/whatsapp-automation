function format(level, message, meta) {
  const timestamp = new Date().toISOString();
  const metadata = meta ? ` ${JSON.stringify(meta)}` : "";
  return `[${timestamp}] [${level}] ${message}${metadata}`;
}

function info(message, meta) {
  console.log(format("INFO", message, meta));
}

function warn(message, meta) {
  console.warn(format("WARN", message, meta));
}

function error(message, meta) {
  console.error(format("ERROR", message, meta));
}

module.exports = {
  info,
  warn,
  error,
};
