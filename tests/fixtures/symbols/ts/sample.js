// function ghostLine() {}
/** Greets someone. */
export function greet(name) {
  return "hi " + name;
}

const LIMIT = 5;
let state = 0;

export const double = (x) => x * 2;

export default class Counter {
  inc() {
    state += 1;
  }
}
