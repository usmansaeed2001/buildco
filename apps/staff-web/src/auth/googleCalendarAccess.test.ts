import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarAccessError, requestCalendarToken } from "./googleCalendarAccess";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";

type Config = Parameters<
  NonNullable<NonNullable<NonNullable<Window["google"]>["accounts"]>["oauth2"]>["initTokenClient"]
>[0];

/**
 * Stand in for Google's script, already loaded.
 *
 * `answer` plays the person at the popup: it is handed the config the app built and
 * calls back however that person would have.
 */
function installGoogle(answer: (config: Config) => void, granted = true) {
  const configs: Config[] = [];
  window.google = {
    accounts: {
      oauth2: {
        initTokenClient: (config) => {
          configs.push(config);
          return { requestAccessToken: () => answer(config) };
        },
        hasGrantedAllScopes: () => granted,
      },
    },
  };
  return configs;
}

describe("requestCalendarToken", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "client-id.apps.googleusercontent.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    delete window.google;
  });

  it("asks for the calendar scope alone and returns the token with its expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T09:00:00Z"));
    const configs = installGoogle((config) =>
      config.callback({ access_token: "ya29.token", expires_in: "3599" }),
    );

    const granted = await requestCalendarToken();

    expect(granted).toEqual({ token: "ya29.token", expiresAt: Date.now() + 3_599_000 });
    expect(configs[0]!.client_id).toBe("client-id.apps.googleusercontent.com");
    expect(configs[0]!.scope).toBe(SCOPE);
    expect(configs[0]).not.toHaveProperty("login_hint");
  });

  it("offers the hinted account first", async () => {
    const configs = installGoogle((config) => config.callback({ access_token: "ya29.token" }));

    await requestCalendarToken({ hint: "sam@example.com" });

    expect(configs[0]!.login_hint).toBe("sam@example.com");
  });

  it("refuses when the person declines", async () => {
    installGoogle((config) => config.callback({ error: "access_denied" }));

    await expect(requestCalendarToken()).rejects.toThrow(/was not granted/);
  });

  it("refuses a token that came back without the calendar permission", async () => {
    // Google lets someone continue with the permission left unticked.
    installGoogle((config) => config.callback({ access_token: "ya29.token" }), false);

    await expect(requestCalendarToken()).rejects.toThrow(/was not granted/);
  });

  it("says the window was closed, and says a blocked popup was blocked", async () => {
    installGoogle((config) => config.error_callback?.({ type: "popup_closed" }));
    await expect(requestCalendarToken()).rejects.toThrow(/was closed/);

    installGoogle((config) => config.error_callback?.({ type: "popup_failed_to_open" }));
    await expect(requestCalendarToken()).rejects.toThrow(/Allow popups/);
  });

  it("fails with a message, not a popup, when the build has no client ID", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    const configs = installGoogle((config) => config.callback({ access_token: "ya29.token" }));

    await expect(requestCalendarToken()).rejects.toBeInstanceOf(CalendarAccessError);
    expect(configs).toEqual([]);
  });
});
