import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSeen, hasUnseen, LIMIT, markSeen, readSeen, unseenIds, writeSeen } from "./seen";

beforeEach(() => clearSeen());
afterEach(() => vi.restoreAllMocks());

describe("readSeen", () => {
  it("is empty before anything has been recorded", () => {
    expect(readSeen("active")).toEqual([]);
  });

  it("round-trips what was written", () => {
    writeSeen("active", ["a", "b"]);
    expect(readSeen("active")).toEqual(["a", "b"]);
  });

  it("keeps statuses apart", () => {
    writeSeen("active", ["a"]);
    expect(readSeen("submitted")).toEqual([]);
  });

  it("survives corrupted storage rather than throwing", () => {
    localStorage.setItem("buildco_seen_active", "{not json");
    expect(readSeen("active")).toEqual([]);
  });

  it("ignores non-string entries", () => {
    localStorage.setItem("buildco_seen_active", JSON.stringify(["a", 42, null, "b"]));
    expect(readSeen("active")).toEqual(["a", "b"]);
  });

  it("returns empty when storage itself is unavailable", () => {
    // Safari private mode and browsers configured to block site data both throw here.
    // The legacy version was unguarded, so the whole render died.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(readSeen("active")).toEqual([]);
  });
});

describe("writeSeen", () => {
  it("does not throw when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => writeSeen("active", ["a"])).not.toThrow();
  });

  it("caps what it stores, keeping the most recent", () => {
    // The legacy version stored every id it had ever seen, per status, for ever.
    const ids = Array.from({ length: LIMIT + 10 }, (_, i) => `id-${i}`);
    writeSeen("active", ids);

    const stored = readSeen("active");
    expect(stored).toHaveLength(LIMIT);
    expect(stored.at(-1)).toBe(`id-${LIMIT + 9}`);
    expect(stored).not.toContain("id-0");
  });
});

describe("unseenIds", () => {
  it("treats everything as new before anything is marked", () => {
    expect(unseenIds("active", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns only what arrived since the last visit", () => {
    markSeen("active", ["a", "b"]);
    expect(unseenIds("active", ["a", "b", "c"])).toEqual(["c"]);
  });

  it("is empty once everything has been seen", () => {
    markSeen("active", ["a", "b"]);
    expect(unseenIds("active", ["a", "b"])).toEqual([]);
    expect(hasUnseen("active", ["a", "b"])).toBe(false);
  });

  it("does not resurrect a dot for something that disappeared", () => {
    markSeen("active", ["a", "b"]);
    expect(hasUnseen("active", ["a"])).toBe(false);
  });
});

describe("markSeen", () => {
  it("replaces rather than merging", () => {
    // An id that has left a status cannot return to it without being new again, and
    // keeping it would pin the key at its cap with entries that mean nothing.
    markSeen("active", ["a", "b"]);
    markSeen("active", ["b", "c"]);

    expect(readSeen("active")).toEqual(["b", "c"]);
  });
});

describe("clearSeen", () => {
  it("removes every status, and nothing else", () => {
    markSeen("active", ["a"]);
    markSeen("submitted", ["b"]);
    localStorage.setItem("unrelated", "keep me");

    clearSeen();

    expect(readSeen("active")).toEqual([]);
    expect(readSeen("submitted")).toEqual([]);
    expect(localStorage.getItem("unrelated")).toBe("keep me");
  });
});
