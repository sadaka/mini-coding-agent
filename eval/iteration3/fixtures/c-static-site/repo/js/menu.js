export const OPEN_CLASS = "is-open";

export function toggled(classList, openClass = OPEN_CLASS) {
  return classList.includes(openClass)
    ? classList.filter((c) => c !== openClass)
    : [...classList, openClass];
}

if (typeof document !== "undefined") {
  const menu = document.getElementById("menu");
  document.getElementById("burger").addEventListener("click", () => {
    menu.className = toggled(menu.className.split(" ").filter(Boolean)).join(" ");
  });
}
