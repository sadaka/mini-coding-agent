import { describe, it, expect } from "vitest";
import { SimpleTokenEstimator } from "../../../src/context/token-estimator.js";

describe("SimpleTokenEstimator", () => {
  const est = new SimpleTokenEstimator();

  it("returns 0 for empty string", () => {
    expect(est.estimate("")).toBe(0);
  });

  it("returns positive value for short text", () => {
    expect(est.estimate("hello")).toBeGreaterThan(0);
  });

  it("longer text produces larger estimate", () => {
    const short = est.estimate("hello");
    const long = est.estimate("hello world this is a longer sentence");
    expect(long).toBeGreaterThan(short);
  });

  it("is deterministic — same input always same output", () => {
    const text = "some repeated text";
    expect(est.estimate(text)).toBe(est.estimate(text));
  });

  it("uses ceil(length/4) formula", () => {
    expect(est.estimate("abcd")).toBe(1);
    expect(est.estimate("abcde")).toBe(2);
    expect(est.estimate("a".repeat(100))).toBe(25);
  });
});
