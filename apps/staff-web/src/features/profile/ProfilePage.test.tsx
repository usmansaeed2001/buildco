import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { makeUser } from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { UserOut } from "@/api/types";
import { ProfilePage } from "./ProfilePage";

const ME = makeUser({
  id: "u-me",
  role: "member",
  full_name: "Sam Member",
  email: "sam@buildco.test",
  phone: null,
});

const SIGNED_PUT = "https://storage.googleapis.com/avatars/u-me/avatar.png";

function serveProfile(me: UserOut = ME) {
  const calls = { patched: [] as Record<string, unknown>[], saved: [] as Record<string, unknown>[] };

  server.use(
    http.get(url("/users/me"), () => HttpResponse.json(me)),
    http.patch(url("/users/me"), async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.patched.push(body);
      return HttpResponse.json({ ...me, ...body });
    }),
    http.post(url("/users/me/avatar-upload-url"), () =>
      HttpResponse.json({
        upload_url: SIGNED_PUT,
        storage_path: "u-me/avatar.png",
        required_headers: { "Content-Type": "image/png" },
        expires_in: 900,
      }),
    ),
    http.put(SIGNED_PUT, () => new HttpResponse(null, { status: 200 })),
    http.put(url("/users/me/avatar"), async ({ request }) => {
      calls.saved.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ...me, avatar_url: "https://storage.test/avatar.png" });
    }),
  );

  return calls;
}

const renderProfile = (me: UserOut = ME) =>
  renderWithProviders(<ProfilePage />, { user: me, route: "/profile", path: "/profile" });

describe("ProfilePage", () => {
  it("loads your name and phone into editable fields", async () => {
    serveProfile(makeUser({ ...ME, phone: "555-0100" }));
    renderProfile();

    expect(await screen.findByLabelText("Full name")).toHaveValue("Sam Member");
    expect(screen.getByLabelText("Phone")).toHaveValue("555-0100");
  });

  it("shows email and role read-only, with the reason", async () => {
    // "Why can't I change this" is answered better by a disabled field than an absent
    // one — and `UserUpdate` accepts neither.
    serveProfile();
    renderProfile();

    expect(await screen.findByLabelText(/Email/)).toHaveAttribute("readonly");
    expect(screen.getByText(/sign-in identity and cannot be changed/)).toBeVisible();
    expect(screen.getByText(/Only an owner or admin can change this/)).toBeVisible();
  });

  it("saves nothing until something changes", async () => {
    serveProfile();
    renderProfile();

    expect(await screen.findByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("sends only the two fields the API accepts", async () => {
    const calls = serveProfile();
    const { user } = renderProfile();
    await screen.findByLabelText("Full name");

    await user.clear(screen.getByLabelText("Full name"));
    await user.type(screen.getByLabelText("Full name"), "Samantha Member");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]).toEqual({ full_name: "Samantha Member", phone: null });
  });

  it("sends a null phone rather than an empty string", async () => {
    const calls = serveProfile(makeUser({ ...ME, phone: "555-0100" }));
    const { user } = renderProfile();
    await screen.findByLabelText("Phone");

    await user.clear(screen.getByLabelText("Phone"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]!.phone).toBeNull();
  });

  it("reports a rejected save without losing what was typed", async () => {
    serveProfile();
    server.use(
      http.patch(url("/users/me"), () => apiError(422, "validation_failed", "Name is too long.")),
    );
    const { user } = renderProfile();
    await screen.findByLabelText("Full name");

    await user.type(screen.getByLabelText("Full name"), "!");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Name is too long.")).toBeVisible();
    expect(screen.getByLabelText("Full name")).toHaveValue("Sam Member!");
  });

  describe("the avatar", () => {
    it("uploads through the signed URL, then records the path", async () => {
      const calls = serveProfile();
      const { user } = renderProfile();
      await screen.findByLabelText("Profile photo");

      await user.upload(
        screen.getByLabelText("Profile photo"),
        new File(["x"], "me.png", { type: "image/png" }),
      );

      await waitFor(() => expect(calls.saved).toHaveLength(1));
      expect(calls.saved[0]).toEqual({ storage_path: "u-me/avatar.png" });
    });

    it("says the rest of the page still works when storage is unconfigured", async () => {
      serveProfile();
      server.use(
        http.post(url("/users/me/avatar-upload-url"), () =>
          apiError(503, "integration_unavailable", "Cloud Storage is not configured."),
        ),
      );
      const { user } = renderProfile();
      await screen.findByLabelText("Profile photo");

      await user.upload(
        screen.getByLabelText("Profile photo"),
        new File(["x"], "me.png", { type: "image/png" }),
      );

      expect(await screen.findByText(/Everything else on this page still works/)).toBeVisible();
    });

    it("reports a rejected upload link", async () => {
      serveProfile();
      server.use(http.put(SIGNED_PUT, () => new HttpResponse(null, { status: 403 })));
      const { user } = renderProfile();
      await screen.findByLabelText("Profile photo");

      await user.upload(
        screen.getByLabelText("Profile photo"),
        new File(["x"], "me.png", { type: "image/png" }),
      );

      expect(await screen.findByText(/upload link was rejected/)).toBeVisible();
    });
  });
});
