/**
 * The reset screen's one job is to be a dead end that reveals nothing.
 *
 * Both the "we sent it" and the "no such account" cases have to look identical, or the
 * form becomes a way to ask whether a given person has an account here.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { ForgotPasswordPage } from "./ForgotPasswordPage";

const sendPasswordResetEmail = vi.hoisted(() => vi.fn());

vi.mock("firebase/auth", () => ({ sendPasswordResetEmail }));

// Deliberately no `beforeEach` clearing this spy. Under vitest 4, calling `mockReset`
// or `mockClear` on it detaches the tracking that marks a returned rejected promise as
// handled, so the two tests below fail with the very error the page catches and
// displays — a green assertion and a red test. Every test sets its own implementation
// and none asserts a call count, so the hook bought nothing to begin with.
vi.mock("@/auth/firebase", () => ({
  getFirebaseAuth: () => ({}),
  describeAuthError: () => "Something went wrong.",
}));

/** Firebase throws `FirebaseError`, an Error carrying a `code`. A plain object would
 *  not survive the SDK's own typing. */
function rejectsWith(code: string): () => Promise<never> {
  return () => Promise.reject(Object.assign(new Error(code), { code }));
}

async function submit(email: string) {
  const { user } = renderWithProviders(<ForgotPasswordPage />, { user: null });
  await user.type(screen.getByLabelText(/email/i), email);
  await user.click(screen.getByRole("button", { name: /send reset link/i }));
  return user;
}

describe("ForgotPasswordPage", () => {

  it("sends a reset email for the address given", async () => {
    sendPasswordResetEmail.mockResolvedValue(undefined);

    await submit("someone@example.com");

    await waitFor(() =>
      expect(sendPasswordResetEmail).toHaveBeenCalledWith({}, "someone@example.com"),
    );
    expect(await screen.findByText(/a reset link is on its way/i)).toBeInTheDocument();
  });

  it("trims the address, so a stray copy-paste space still works", async () => {
    sendPasswordResetEmail.mockResolvedValue(undefined);

    await submit("  spaced@example.com  ");

    await waitFor(() =>
      expect(sendPasswordResetEmail).toHaveBeenCalledWith({}, "spaced@example.com"),
    );
  });

  it("says exactly the same thing for an address with no account", async () => {
    // The whole point: an unregistered address must not be distinguishable from a
    // registered one, or this page answers "does this person work here?".
    sendPasswordResetEmail.mockImplementation(rejectsWith("auth/user-not-found"));

    await submit("stranger@example.com");

    expect(await screen.findByText(/a reset link is on its way/i)).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it("does report a real failure, which is not the same as a missing account", async () => {
    sendPasswordResetEmail.mockImplementation(rejectsWith("auth/network-request-failed"));

    await submit("someone@example.com");

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.queryByText(/a reset link is on its way/i)).not.toBeInTheDocument();
  });
});
