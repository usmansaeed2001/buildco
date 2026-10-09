/**
 * The sign-up screen as an invitation's landing page.
 *
 * An invitation email links to `/signup?invite=<token>&email=<address>`. The token is
 * picked up at startup by `auth/invite.ts` and is not this screen's concern; what the
 * screen owes the invitee is to say why they are here and not make them retype the one
 * address the invitation works for.
 */
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { SignupPage } from "./SignupPage";

vi.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("@/auth/firebase", () => ({
  getFirebaseAuth: () => ({}),
  describeAuthError: () => "Something went wrong.",
}));

vi.mock("./googleSignIn", () => ({ signInWithGoogle: vi.fn() }));

function renderSignup(route: string) {
  return renderWithProviders(<SignupPage />, { user: null, route });
}

describe("SignupPage", () => {
  it("greets someone arriving from an invitation with their address filled in", () => {
    renderSignup("/signup?invite=tok-123&email=new.hire%40buildco.com");

    expect(screen.getByText(/You have been invited to join the BuildCo team/)).toBeVisible();
    expect(screen.getByLabelText(/^Email/)).toHaveValue("new.hire@buildco.com");
  });

  it("is an ordinary sign-up form otherwise", () => {
    renderSignup("/signup");

    expect(screen.queryByText(/You have been invited/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/)).toHaveValue("");
  });
});
