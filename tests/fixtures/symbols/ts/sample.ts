// function ghostLine() {}
/* class GhostBlock { method() {} } */
import { Base } from "./base";

/**
 * Adds two numbers.
 * Returns the sum.
 */
export function add(a: number, b: number): number {
  return a + b;
}

function localHelper(x: string) {
  const insideLocal = 1; // locals are not indexed
  function nestedFn() {}
  return x + insideLocal;
}

const decoy = "function fakeInString() {} class FakeClass {}";

export default class Calculator<T> extends Base {
  /** Running total. */
  private total = 0;
  handle = (x: number) => x * 2;
  constructor(public n: number) {
    super();
  }
  async run(): Promise<void> {
    this.total += 1;
  }
}

export abstract class Shape {
  abstract area(): number;
}

declare function external(x: string): void;
function overloaded(a: string): void;
function overloaded(a: number): void;
function overloaded(a: any): void {}

export const multiply = (a: number, b: number) => a * b, SCALE = 10;
let counter = 0;
var legacy = 1;
const { d1, d2 } = { d1: 1, d2: 2 };

/** A user. */
export interface User {
  id: number;
  name(): string;
}

export type UserId = string | number;

enum Color {
  Red,
  Green,
}

namespace Geometry {
  export function area(w: number, h: number) {
    return w * h;
  }
}

export default function () {}
