import { afterEach, describe, expect, it, vi } from "vitest";
import { captureInviteFromUrl, clearInviteToken, pendingInviteToken } from "./invite";

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("the invitation token", () => {
  it("is lifted out of the link the app was opened with", () => {
    captureInviteFromUrl("?invite=tok-123&email=new.hire%40buildco.com");

    expect(pendingInviteToken()).toBe("tok-123");
  });

  it("survives a later page that has no token in its URL", () => {
    // The invitee lands on /signup, realises they already have a password, and goes to
    // /login. The token has to still be there when they sign in.
    captureInviteFromUrl("?invite=tok-123");
    captureInviteFromUrl("");

    expect(pendingInviteToken()).toBe("tok-123");
  });

  it("is absent on an ordinary visit", () => {
    captureInviteFromUrl("?from=/estimates");

    expect(pendingInviteToken()).toBeNull();
  });

  it("is forgotten once it has been used", () => {
    captureInviteFromUrl("?invite=tok-123");
    clearInviteToken();

    expect(pendingInviteToken()).toBeNull();
  });

  it("does not take the app down when storage is unavailable", () => {
    // Safari private mode, or a browser set to block site data.
    const blocked = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);

    expect(() => captureInviteFromUrl("?invite=tok-123")).not.toThrow();
    expect(pendingInviteToken()).toBeNull();
    expect(() => clearInviteToken()).not.toThrow();
  });
});
