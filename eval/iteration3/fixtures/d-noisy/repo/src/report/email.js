import { weekDays } from "./week.js";

export function weeklyEmail(date) {
  return `Your week: ${weekDays(date).join(", ")}`;
}
