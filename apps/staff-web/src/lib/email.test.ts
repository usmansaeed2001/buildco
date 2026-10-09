import { describe, expect, it } from "vitest";
import { isEmail, normaliseEmail } from "./email";

describe("isEmail", () => {
  it.each(["adjuster@insurer.com", "first.last+tag@sub.example.co.uk", "  padded@example.com  "])(
    "accepts %s",
    (value) => {
      expect(isEmail(value)).toBe(true);
    },
  );

  it.each([
    "",
    "no-at-sign",
    "two@@example.com",
    "missing@tld",
    "has space@example.com",
    "trailing@example.com,",
    "a@example.com; b@example.com",
    "Name <a@example.com>",
  ])("refuses %j", (value) => {
    expect(isEmail(value)).toBe(false);
  });
});

describe("normaliseEmail", () => {
  it("trims and lower-cases, matching how the API compares addresses", () => {
    expect(normaliseEmail("  Adjuster@Insurer.COM ")).toBe("adjuster@insurer.com");
  });
});
