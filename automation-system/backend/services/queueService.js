const { query, withTransaction } = require("../database/db");

async function enqueueMessage({
  reminderId,
  phone,
  message,
  reminderDate,
  sendAfterTime = null,
  timezone = "Asia/Kolkata",
}) {
  const hasSendTime = Boolean(sendAfterTime);

  const sql = `
    INSERT INTO message_queue (reminder_id, phone, message, reminder_date, status, send_after)
    VALUES (
      $1,
      $2,
      $3,
      $4,
      'queued',
      CASE
        WHEN $5::BOOLEAN
          THEN ((CURRENT_TIMESTAMP AT TIME ZONE $6)::DATE::TEXT || ' ' || $7 || ':00')::TIMESTAMP AT TIME ZONE $6
        ELSE NOW()
      END
    )
    ON CONFLICT (phone, reminder_date)
    DO NOTHING
    RETURNING id
  `;

  const { rows } = await query(sql, [
    reminderId,
    phone,
    message,
    reminderDate,
    hasSendTime,
    timezone,
    sendAfterTime,
  ]);
  return rows[0] ? rows[0].id : null;
}

async function dequeueNextMessage() {
  return withTransaction(async (client) => {
    const selectSql = `
      SELECT *
      FROM message_queue
      WHERE status = 'queued'
        AND send_after <= NOW()
      ORDER BY queued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;

    const { rows } = await client.query(selectSql);
    if (!rows.length) {
      return null;
    }

    const row = rows[0];

    await client.query(
      `
        UPDATE message_queue
        SET status = 'processing', attempts = attempts + 1
        WHERE id = $1
      `,
      [row.id]
    );

    return row;
  });
}

async function markQueuedWithDelay(id, errorMessage, delaySeconds = 60) {
  const sql = `
    UPDATE message_queue
    SET status = 'queued',
        last_error = $2,
        send_after = NOW() + ($3 * INTERVAL '1 second')
    WHERE id = $1
  `;
  await query(sql, [id, errorMessage, delaySeconds]);
}

async function markSent(id) {
  await query(
    `
      UPDATE message_queue
      SET status = 'sent', processed_at = NOW(), last_error = NULL
      WHERE id = $1
    `,
    [id]
  );
}

async function markSkipped(id, reason) {
  await query(
    `
      UPDATE message_queue
      SET status = 'skipped', processed_at = NOW(), last_error = $2
      WHERE id = $1
    `,
    [id, reason]
  );
}

async function markFailed(id, errorMessage) {
  await query(
    `
      UPDATE message_queue
      SET status = 'failed', processed_at = NOW(), last_error = $2
      WHERE id = $1
    `,
    [id, errorMessage]
  );
}

async function getQueueCounts() {
  const { rows } = await query(
    `
      SELECT status, COUNT(*)::INT AS count
      FROM message_queue
      GROUP BY status
    `
  );

  const counts = { queued: 0, processing: 0, sent: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

module.exports = {
  enqueueMessage,
  dequeueNextMessage,
  markQueuedWithDelay,
  markSent,
  markSkipped,
  markFailed,
  getQueueCounts,
};
