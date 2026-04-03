function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 10);
}

function applyTemplate(template, data) {
  return template.replace(/\{(ownerName|petName|vaccine|nextDueDate|frequency)\}/g, (_, key) => {
    if (key === "nextDueDate") return formatDate(data.nextDueDate);
    if (key === "frequency") return String(data.frequencyDays || 30);
    return String(data[key] || "");
  });
}

/**
 * Build a combined reminder message for one owner.
 * `items` is an array of { pet_name, vaccine, next_due_date, frequency_days }.
 * If only one item, uses the template as-is. If multiple, lists all pets.
 */
function buildReminderMessage({ ownerName, items, template }) {
  // Single pet — use template if available
  if (items.length === 1) {
    const item = items[0];
    if (template && String(template).trim()) {
      return applyTemplate(String(template), {
        ownerName,
        petName: item.pet_name,
        vaccine: item.vaccine,
        nextDueDate: item.next_due_date,
        frequencyDays: item.frequency_days,
      });
    }
    return [
      `Hello ${ownerName}`,
      "",
      "Reminder from Vet Clinic.",
      "",
      `${item.pet_name} is due for the ${item.vaccine} vaccine on ${formatDate(item.next_due_date)}.`,
      "",
      "Please visit the clinic.",
      "",
      "Thank you.",
    ].join("\n");
  }

  // Multiple pets — combined message
  const petLines = items.map(
    (i) => `• ${i.pet_name} — ${i.vaccine} (due ${formatDate(i.next_due_date)})`
  );
  return [
    `Hello ${ownerName}`,
    "",
    "Reminder from Vet Clinic.",
    "",
    "The following vaccines are due:",
    ...petLines,
    "",
    "Please visit the clinic.",
    "",
    "Thank you.",
  ].join("\n");
}

/**
 * Build an overdue reminder message.
 */
function buildOverdueMessage({ ownerName, items, template }) {
  if (items.length === 1) {
    const item = items[0];
    if (template && String(template).trim()) {
      return applyTemplate(String(template), {
        ownerName,
        petName: item.pet_name,
        vaccine: item.vaccine,
        nextDueDate: item.next_due_date,
        frequencyDays: item.frequency_days,
      });
    }
  }

  const petLines = items.map(
    (i) => `• ${i.pet_name} — ${i.vaccine} (was due ${formatDate(i.next_due_date)})`
  );

  return [
    `Hello ${ownerName}`,
    "",
    "This is an overdue reminder from Vet Clinic.",
    "",
    items.length === 1
      ? `${items[0].pet_name}'s ${items[0].vaccine} vaccine was due on ${formatDate(items[0].next_due_date)} and is now overdue.`
      : ["The following vaccines are overdue:", ...petLines].join("\n"),
    "",
    "Please visit the clinic as soon as possible.",
    "",
    "Thank you.",
  ].join("\n");
}

module.exports = {
  buildReminderMessage,
  buildOverdueMessage,
};
