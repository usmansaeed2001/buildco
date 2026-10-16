import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";
import { makeUser } from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { UserOut } from "@/api/types";
import { ProfilePage } from "./ProfilePage";

// jsdom has no canvas, so the crop itself cannot be drawn here; the geometry is covered
// by `lib/crop.test.ts`. What this file checks is that the crop, not the original, is
// what gets uploaded.
vi.mock("@/lib/crop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/crop")>()),
  renderCrop: vi.fn(async () => new Blob(["cropped"], { type: "image/jpeg" })),
}));

const ME = makeUser({
  id: "u-me",
  role: "member",
  full_name: "Sam Member",
  email: "sam@buildco.test",
  phone: null,
});

const SIGNED_PUT = "https://storage.googleapis.com/avatars/u-me/avatar.png";
const PUBLIC_URL = "https://storage.test/avatars/u-me/avatar.png";

function serveProfile(me: UserOut = ME) {
  const calls = {
    patched: [] as Record<string, unknown>[],
    saved: [] as Record<string, unknown>[],
    tickets: [] as Record<string, unknown>[],
    uploaded: [] as string[],
  };

  server.use(
    http.get(url("/users/me"), () => HttpResponse.json(me)),
    http.patch(url("/users/me"), async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.patched.push(body);
      return HttpResponse.json({ ...me, ...body });
    }),
    http.post(url("/users/me/avatar-upload-url"), async ({ request }) => {
      calls.tickets.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({
        upload_url: SIGNED_PUT,
        storage_path: "u-me/avatar.png",
        required_headers: { "Content-Type": "image/png" },
        expires_in: 900,
        public_url: PUBLIC_URL,
      });
    }),
    http.put(SIGNED_PUT, async ({ request }) => {
      calls.uploaded.push(await request.text());
      return new HttpResponse(null, { status: 200 });
    }),
    http.put(url("/users/me/avatar"), async ({ request }) => {
      calls.saved.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ...me, avatar_url: PUBLIC_URL });
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
    beforeEach(() => {
      URL.createObjectURL = vi.fn(() => "blob:chosen-photo");
      URL.revokeObjectURL = vi.fn();
    });
    afterEach(() => {
      // @ts-expect-error -- jsdom has neither; put it back the way it was.
      delete URL.createObjectURL;
      // @ts-expect-error -- as above.
      delete URL.revokeObjectURL;
    });

    /** Pick a photo, let it "load" in the cropper, and return the open dialog. */
    async function pick(user: UserEvent) {
      await user.upload(
        await screen.findByLabelText("Profile photo"),
        new File(["original"], "me.png", { type: "image/png" }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Crop your photo" });
      const photo = within(dialog).getByAltText("The photo you chose");
      Object.defineProperty(photo, "naturalWidth", { value: 800 });
      Object.defineProperty(photo, "naturalHeight", { value: 600 });
      fireEvent.load(photo);
      return dialog;
    }

    it("opens the cropper instead of uploading straight away", async () => {
      const calls = serveProfile();
      const { user } = renderProfile();

      const dialog = await pick(user);

      expect(within(dialog).getByRole("group", { name: /Crop area/ })).toBeVisible();
      expect(calls.tickets).toEqual([]);
    });

    it("starts from the largest centred square", async () => {
      serveProfile();
      const { user } = renderProfile();

      const area = within(await pick(user)).getByRole("group", { name: /Crop area/ });

      // 600×600 of an 800×600 photo, 100px in from the left.
      expect(area.style.left).toBe("12.5%");
      expect(area.style.top).toBe("0%");
      expect(area.style.width).toBe("75%");
      expect(area.style.height).toBe("100%");
    });

    it("moves the square with the arrow keys", async () => {
      serveProfile();
      const { user } = renderProfile();
      const area = within(await pick(user)).getByRole("group", { name: /Crop area/ });

      area.focus();
      await user.keyboard("{ArrowRight}");

      expect(area.style.left).not.toBe("12.5%");
    });

    it("uploads the crop through the signed URL, then records a fresh public URL", async () => {
      const calls = serveProfile();
      const { user } = renderProfile();
      const dialog = await pick(user);

      await user.click(within(dialog).getByRole("button", { name: "Save photo" }));

      await waitFor(() => expect(calls.saved).toHaveLength(1));
      expect(calls.tickets[0]).toEqual({ file_name: "avatar.jpg", content_type: "image/jpeg" });
      expect(calls.uploaded).toEqual(["cropped"]);
      // A new query string each time, or browsers keep showing the photo it replaced.
      expect(calls.saved[0]!.avatar_url).toMatch(
        new RegExp(`^${PUBLIC_URL.replace(/[.]/g, "\\.")}\\?v=\\d+$`),
      );
    });

    it("uploads nothing when the crop is cancelled", async () => {
      const calls = serveProfile();
      const { user } = renderProfile();
      const dialog = await pick(user);

      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Crop your photo" })).not.toBeInTheDocument(),
      );
      expect(calls.tickets).toEqual([]);
    });

    it("opens your photo full size when it is clicked", async () => {
      serveProfile(makeUser({ ...ME, avatar_url: PUBLIC_URL }));
      const { user } = renderProfile();

      await user.click(await screen.findByRole("button", { name: "View photo of Sam Member" }));

      const viewer = await screen.findByRole("dialog", { name: "Sam Member" });
      expect(within(viewer).getByAltText("Photo of Sam Member")).toHaveAttribute("src", PUBLIC_URL);
    });

    it("says the rest of the page still works when storage is unconfigured", async () => {
      serveProfile();
      server.use(
        http.post(url("/users/me/avatar-upload-url"), () =>
          apiError(503, "integration_unavailable", "Cloud Storage is not configured."),
        ),
      );
      const { user } = renderProfile();
      const dialog = await pick(user);

      await user.click(within(dialog).getByRole("button", { name: "Save photo" }));

      expect(await screen.findByText(/Everything else on this page still works/)).toBeVisible();
    });

    it("reports a rejected upload link", async () => {
      serveProfile();
      server.use(http.put(SIGNED_PUT, () => new HttpResponse(null, { status: 403 })));
      const { user } = renderProfile();
      const dialog = await pick(user);

      await user.click(within(dialog).getByRole("button", { name: "Save photo" }));

      expect(await screen.findByText(/upload link was rejected/)).toBeVisible();
    });
  });
});

describe("what the assistant remembers", () => {
  const MEMORY = {
    id: "m-1",
    category: "identity",
    content: "Prefers to be called Sam",
    source: "explicit",
    evidence: "please call me Sam",
    created_at: "2026-10-01T09:00:00Z",
    updated_at: "2026-10-01T09:00:00Z",
  };

  function serveMemories(memories: (typeof MEMORY)[], enabled = true) {
    let held = memories;
    const deleted: string[] = [];
    server.use(
      http.get(url("/agent/status"), () =>
        HttpResponse.json({
          enabled,
          max_session_seconds: 1800,
          daily_limit_seconds: 600,
          used_seconds: 0,
          remaining_seconds: 600,
          resets_at: "2026-10-15T00:00:00Z",
        }),
      ),
      http.get(url("/agent/memories"), () => HttpResponse.json(held)),
      http.delete(url("/agent/memories/:id"), ({ params }) => {
        deleted.push(String(params.id));
        held = held.filter((memory) => memory.id !== params.id);
        return HttpResponse.json({ success: true });
      }),
    );
    return deleted;
  }

  it("is not on the page for someone who is not offered the assistant and has none", async () => {
    serveProfile();
    serveMemories([], false);
    renderProfile();

    await screen.findByLabelText("Full name");
    expect(screen.queryByText("What the assistant remembers")).not.toBeInTheDocument();
  });

  it("shows each memory with what kind it is and the words it came from", async () => {
    serveProfile();
    serveMemories([MEMORY, { ...MEMORY, id: "m-2", content: "Keeps answers short", category: "preference", source: "inferred", evidence: "keep it brief" }]);
    renderProfile();

    expect(await screen.findByText("Prefers to be called Sam")).toBeVisible();
    expect(screen.getByText("Identity")).toBeVisible();
    expect(screen.getByText("please call me Sam")).toBeVisible();
    expect(screen.getByText("Preference")).toBeVisible();
    expect(screen.getByText(/noticed, not asked for/)).toBeVisible();
    expect(screen.getAllByText(/^Saved /)).toHaveLength(2);
  });

  it("says so when there is nothing yet", async () => {
    serveProfile();
    serveMemories([]);
    renderProfile();

    expect(await screen.findByText("What the assistant remembers")).toBeVisible();
    // And what would appear here, so an empty card is not a dead end.
    expect(screen.getByText(/Nothing yet\. When you tell the assistant/)).toBeVisible();
  });

  it("deletes one after asking, and it goes from the list", async () => {
    serveProfile();
    const deleted = serveMemories([MEMORY]);
    const { user } = renderProfile();

    await user.click(
      await screen.findByRole("button", { name: "Delete memory: Prefers to be called Sam" }),
    );
    expect(deleted).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleted).toEqual(["m-1"]));
    await waitFor(() =>
      expect(screen.queryByText("Prefers to be called Sam")).not.toBeInTheDocument(),
    );
  });

  it("still lets someone delete their memories after the assistant is switched off", async () => {
    serveProfile();
    serveMemories([MEMORY], false);
    renderProfile();

    expect(
      await screen.findByRole("button", { name: "Delete memory: Prefers to be called Sam" }),
    ).toBeVisible();
  });
});
