const DAY_MS = 86400000;

export function weekStart(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

export function weekDays(date) {
  const start = new Date(weekStart(date));
  return Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10));
}
