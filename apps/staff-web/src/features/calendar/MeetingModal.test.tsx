import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { makeMeeting, makeUser } from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { MeetingOut } from "@/api/types";
import { localDayKey, toDateInput, toTimeInput } from "@/domain/calendar";
import { MeetingModal } from "./MeetingModal";

const OWNER = makeUser({ id: "owner-1", role: "owner" });
const MEMBER_USER = makeUser({ id: "member-1", role: "member", full_name: "Sam Member" });

const MARCH_15 = new Date(2026, 2, 15);

function serveMutations() {
  const created: Record<string, unknown>[] = [];
  const patched: Record<string, unknown>[] = [];
  const deleted: URLSearchParams[] = [];

  server.use(
    http.get(url("/users"), () => HttpResponse.json([OWNER, MEMBER_USER])),
    http.post(url("/meetings"), async ({ request }) => {
      created.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(makeMeeting());
    }),
    http.patch(url("/meetings/:id"), async ({ request }) => {
      patched.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(makeMeeting());
    }),
    http.delete(url("/meetings/:id"), ({ request }) => {
      deleted.push(new URL(request.url).searchParams);
      return HttpResponse.json({ ok: true });
    }),
  );

  return { created, patched, deleted };
}

function renderModal({
  meeting = null,
  canManage = true,
  googleAccessToken = null,
}: {
  meeting?: MeetingOut | null;
  canManage?: boolean;
  googleAccessToken?: string | null;
} = {}) {
  return renderWithProviders(
    <MeetingModal
      open
      meeting={meeting}
      defaultDate={MARCH_15}
      canManage={canManage}
      onClose={() => {}}
    />,
    { user: OWNER, auth: { googleAccessToken } },
  );
}

/** An existing meeting at 09:00–10:00 local on 15 March 2026. */
function existing(overrides: Partial<MeetingOut> = {}): MeetingOut {
  return makeMeeting({
    id: "meet-1",
    title: "Site walkthrough",
    description: "Review the scope",
    location: "12 Oak Street",
    color: "#3B82F6",
    start_time: new Date(2026, 2, 15, 9, 0).toISOString(),
    end_time: new Date(2026, 2, 15, 10, 0).toISOString(),
    attendees: [],
    ...overrides,
  });
}

describe("MeetingModal", () => {
  describe("creating", () => {
    it("opens on the day that was clicked", () => {
      serveMutations();
      renderModal();

      expect(screen.getByLabelText("Date")).toHaveValue(localDayKey(MARCH_15));
    });

    it("sends the times as local instants, not UTC-shifted", async () => {
      // The one real hazard on this screen: composing "2026-03-15" + "14:00" by string
      // concatenation with a "Z" shifts every meeting by the viewer's offset.
      const { created } = serveMutations();
      const { user } = renderModal();

      await user.type(screen.getByLabelText(/^Title/), "Site walkthrough");
      await user.clear(screen.getByLabelText("Start"));
      await user.type(screen.getByLabelText("Start"), "14:00");
      await user.click(screen.getByRole("button", { name: "Create meeting" }));

      await waitFor(() => expect(created).toHaveLength(1));
      const start = new Date(created[0]!.start_time as string);
      expect(start.getHours()).toBe(14);
      expect(localDayKey(start)).toBe(localDayKey(MARCH_15));
    });

    it("defaults the end to an hour after the start", async () => {
      serveMutations();
      const { user } = renderModal();

      await user.clear(screen.getByLabelText("Start"));
      await user.type(screen.getByLabelText("Start"), "14:00");

      expect(screen.getByLabelText(/^End/)).toHaveValue("15:00");
    });

    it("refuses an end before the start, and says why", async () => {
      serveMutations();
      const { user } = renderModal();

      await user.type(screen.getByLabelText(/^Title/), "Backwards");
      await user.clear(screen.getByLabelText(/^End/));
      await user.type(screen.getByLabelText(/^End/), "08:00");

      expect(screen.getByText("Must be after the start time.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Create meeting" })).toBeDisabled();
    });

    it("requires a title", () => {
      serveMutations();
      renderModal();
      expect(screen.getByRole("button", { name: "Create meeting" })).toBeDisabled();
    });

    it("sends the chosen attendees", async () => {
      const { created } = serveMutations();
      const { user } = renderModal();
      await screen.findByLabelText("Sam Member");

      await user.type(screen.getByLabelText(/^Title/), "Walkthrough");
      await user.click(screen.getByLabelText("Sam Member"));
      await user.click(screen.getByRole("button", { name: "Create meeting" }));

      await waitFor(() => expect(created).toHaveLength(1));
      expect(created[0]!.attendee_ids).toEqual([MEMBER_USER.id]);
    });

    describe("guests", () => {
      const GUEST = "adjuster@insurer.com";

      it("invites someone outside the team by email", async () => {
        const { created } = serveMutations();
        const { user } = renderModal();

        await user.type(screen.getByLabelText(/^Title/), "Walkthrough");
        await user.type(screen.getByLabelText("Invite by email"), GUEST);
        await user.click(screen.getByRole("button", { name: "Add" }));

        // Added to the list, and the field is cleared for the next one.
        expect(within(screen.getByRole("list", { name: "Guests" })).getByText(GUEST)).toBeVisible();
        expect(screen.getByLabelText("Invite by email")).toHaveValue("");

        await user.click(screen.getByRole("button", { name: "Create meeting" }));
        await waitFor(() => expect(created).toHaveLength(1));
        expect(created[0]!.attendee_emails).toEqual([GUEST]);
      });

      it("adds a guest on Enter without closing the dialog", async () => {
        const { created } = serveMutations();
        const { user } = renderModal();

        await user.type(screen.getByLabelText("Invite by email"), `${GUEST}{Enter}`);

        expect(within(screen.getByRole("list", { name: "Guests" })).getByText(GUEST)).toBeVisible();
        expect(created).toEqual([]);
      });

      it("takes several pasted addresses at once, without duplicates", async () => {
        const { user } = renderModal();
        serveMutations();

        await user.type(
          screen.getByLabelText("Invite by email"),
          `${GUEST}, pa@insurer.com ${GUEST.toUpperCase()}{Enter}`,
        );

        const listed = within(screen.getByRole("list", { name: "Guests" }))
          .getAllByRole("listitem")
          .map((item) => item.textContent);
        expect(listed).toEqual([`${GUEST}×`, "pa@insurer.com×"]);
      });

      it("refuses something that is not an address, and says which", async () => {
        serveMutations();
        const { user } = renderModal();

        await user.type(screen.getByLabelText("Invite by email"), "not-an-address{Enter}");

        expect(screen.getByText('"not-an-address" is not an email address.')).toBeVisible();
        expect(screen.queryByRole("list", { name: "Guests" })).not.toBeInTheDocument();
      });

      it("includes an address that was typed but never added", async () => {
        // The easiest way to believe you invited someone you did not.
        const { created } = serveMutations();
        const { user } = renderModal();

        await user.type(screen.getByLabelText(/^Title/), "Walkthrough");
        await user.type(screen.getByLabelText("Invite by email"), GUEST);
        await user.click(screen.getByRole("button", { name: "Create meeting" }));

        await waitFor(() => expect(created).toHaveLength(1));
        expect(created[0]!.attendee_emails).toEqual([GUEST]);
      });

      it("does not save while the guest field holds something invalid", async () => {
        const { created } = serveMutations();
        const { user } = renderModal();

        await user.type(screen.getByLabelText(/^Title/), "Walkthrough");
        await user.type(screen.getByLabelText("Invite by email"), "adjuster@");
        await user.click(screen.getByRole("button", { name: "Create meeting" }));

        expect(screen.getByText('"adjuster@" is not an email address.')).toBeVisible();
        expect(created).toEqual([]);
      });

      it("removes a guest", async () => {
        const { created } = serveMutations();
        const { user } = renderModal();

        await user.type(screen.getByLabelText(/^Title/), "Walkthrough");
        await user.type(screen.getByLabelText("Invite by email"), `${GUEST}{Enter}`);
        await user.click(screen.getByRole("button", { name: `Remove ${GUEST}` }));
        await user.click(screen.getByRole("button", { name: "Create meeting" }));

        await waitFor(() => expect(created).toHaveLength(1));
        expect(created[0]!.attendee_emails).toEqual([]);
      });
    });

    it("creates without a Google token, and says a Meet link is not included", async () => {
      // Absent is the normal case, not a degraded one.
      const { created } = serveMutations();
      const { user } = renderModal({ googleAccessToken: null });

      expect(screen.getByText(/No Google Meet link will be added/)).toBeVisible();

      await user.type(screen.getByLabelText(/^Title/), "Walkthrough");
      await user.click(screen.getByRole("button", { name: "Create meeting" }));

      await waitFor(() => expect(created).toHaveLength(1));
      expect(created[0]!.google_access_token).toBeNull();
    });

    it("passes the Google token when one is held", async () => {
      const { created } = serveMutations();
      const { user } = renderModal({ googleAccessToken: "ya29.token" });

      await user.type(screen.getByLabelText(/^Title/), "Walkthrough");
      await user.click(screen.getByRole("button", { name: "Create meeting" }));

      await waitFor(() => expect(created).toHaveLength(1));
      expect(created[0]!.google_access_token).toBe("ya29.token");
      expect(screen.queryByText(/No Google Meet link will be added/)).not.toBeInTheDocument();
    });
  });

  describe("editing", () => {
    it("loads the meeting into the form in local time", () => {
      serveMutations();
      const meeting = existing();
      renderModal({ meeting });

      expect(screen.getByLabelText(/^Title/)).toHaveValue("Site walkthrough");
      expect(screen.getByLabelText("Date")).toHaveValue(toDateInput(meeting.start_time));
      expect(screen.getByLabelText("Start")).toHaveValue(toTimeInput(meeting.start_time));
      expect(screen.getByLabelText("Location")).toHaveValue("12 Oak Street");
    });

    it("sends only what changed", async () => {
      const { patched } = serveMutations();
      const { user } = renderModal({ meeting: existing() });

      await user.clear(screen.getByLabelText("Location"));
      await user.type(screen.getByLabelText("Location"), "8 Elm Road");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(patched).toHaveLength(1));
      expect(patched[0]).toEqual({ location: "8 Elm Road" });
    });

    it("does not resend the whole meeting for a colour change", async () => {
      // The backend re-invites only on a material change. Sending everything each time
      // would re-invite the team for a recolour, which is what trained people to
      // ignore the legacy invites.
      const { patched } = serveMutations();
      const { user } = renderModal({ meeting: existing() });

      await user.click(screen.getByRole("button", { name: "Colour #10B981" }));
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(patched).toHaveLength(1));
      expect(patched[0]).toEqual({ color: "#10B981" });
      expect(patched[0]).not.toHaveProperty("attendee_ids");
      expect(patched[0]).not.toHaveProperty("start_time");
    });

    it("sends nothing at all when nothing changed", async () => {
      const { patched } = serveMutations();
      const { user } = renderModal({ meeting: existing() });

      await user.click(screen.getByRole("button", { name: "Save changes" }));

      // A PATCH with an empty body would still count as an update server-side.
      await waitFor(() => expect(patched).toEqual([]));
    });

    it("replaces the attendee list when it changes", async () => {
      const { patched } = serveMutations();
      const meeting = existing({
        attendees: [
          { id: "a1", user_id: MEMBER_USER.id, email: MEMBER_USER.email, name: "Sam Member" },
        ],
      });
      const { user } = renderModal({ meeting });
      await screen.findByLabelText("Sam Member");

      await user.click(screen.getByLabelText("Sam Member"));
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(patched).toHaveLength(1));
      expect(patched[0]!.attendee_ids).toEqual([]);
    });

    describe("guests", () => {
      const withGuest = () =>
        existing({
          attendees: [
            { id: "a1", user_id: MEMBER_USER.id, email: MEMBER_USER.email, name: "Sam Member" },
            { id: "a2", user_id: null, email: "Adjuster@Insurer.com", name: "" },
          ],
        });

      it("shows the guests already on the meeting, apart from the team", async () => {
        serveMutations();
        renderModal({ meeting: withGuest() });

        const guests = within(screen.getByRole("list", { name: "Guests" }));
        expect(guests.getByText("adjuster@insurer.com")).toBeVisible();
        // A team member is a ticked box, never a guest chip.
        expect(guests.queryByText(MEMBER_USER.email)).not.toBeInTheDocument();
        expect(await screen.findByLabelText("Sam Member")).toBeChecked();
      });

      it("sends only the guest list when a guest is added", async () => {
        // The member half is untouched, so it must not be resent — the two lists are
        // independent, and resending one would look like a change to the server.
        const { patched } = serveMutations();
        const { user } = renderModal({ meeting: withGuest() });

        await user.type(screen.getByLabelText("Invite by email"), "pa@insurer.com{Enter}");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        await waitFor(() => expect(patched).toHaveLength(1));
        expect(patched[0]).toEqual({
          attendee_emails: ["adjuster@insurer.com", "pa@insurer.com"],
        });
      });

      it("sends an empty guest list when the last guest is removed", async () => {
        const { patched } = serveMutations();
        const { user } = renderModal({ meeting: withGuest() });

        await user.click(screen.getByRole("button", { name: "Remove adjuster@insurer.com" }));
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        await waitFor(() => expect(patched).toHaveLength(1));
        expect(patched[0]).toEqual({ attendee_emails: [] });
      });

      it("does not resend the guests when only the team changed", async () => {
        const { patched } = serveMutations();
        const { user } = renderModal({ meeting: withGuest() });
        await screen.findByLabelText("Sam Member");

        await user.click(screen.getByLabelText("Sam Member"));
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        await waitFor(() => expect(patched).toHaveLength(1));
        expect(patched[0]).toEqual({ attendee_ids: [] });
      });

      it("lists guests read-only for someone who cannot manage the meeting", () => {
        serveMutations();
        renderModal({ meeting: withGuest(), canManage: false });

        expect(
          within(screen.getByRole("list", { name: "Guests" })).getByText("adjuster@insurer.com"),
        ).toBeVisible();
        expect(screen.queryByLabelText("Invite by email")).not.toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "Remove adjuster@insurer.com" }),
        ).not.toBeInTheDocument();
      });
    });

    it("offers the Meet link when there is one", () => {
      serveMutations();
      renderModal({ meeting: existing({ meet_link: "https://meet.google.com/abc-defg" }) });

      expect(screen.getByRole("link", { name: "Join the Google Meet" })).toHaveAttribute(
        "href",
        "https://meet.google.com/abc-defg",
      );
    });

    it("confirms before cancelling, and warns that attendees are notified", async () => {
      const { deleted } = serveMutations();
      const { user } = renderModal({ meeting: existing() });

      await user.click(screen.getByRole("button", { name: "Cancel meeting" }));
      expect(screen.getByText(/will receive a cancellation/)).toBeVisible();
      expect(deleted).toEqual([]);

      await user.click(screen.getAllByRole("button", { name: "Cancel meeting" })[1]!);
      await waitFor(() => expect(deleted).toHaveLength(1));
    });

    it("passes the Google token when cancelling, so the calendar event goes too", async () => {
      const { deleted } = serveMutations();
      const { user } = renderModal({ meeting: existing(), googleAccessToken: "ya29.token" });

      await user.click(screen.getByRole("button", { name: "Cancel meeting" }));
      await user.click(screen.getAllByRole("button", { name: "Cancel meeting" })[1]!);

      await waitFor(() => expect(deleted).toHaveLength(1));
      expect(deleted[0]!.get("google_access_token")).toBe("ya29.token");
    });
  });

  describe("read-only", () => {
    it("disables every field and offers no save or cancel", () => {
      serveMutations();
      renderModal({ meeting: existing(), canManage: false });

      expect(screen.getByLabelText(/^Title/)).toBeDisabled();
      expect(screen.getByLabelText("Date")).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel meeting" })).not.toBeInTheDocument();
      // "Done", not "Close" — the modal's own × is already labelled Close, and two
      // controls with the same accessible name read as duplicates.
      expect(screen.getByRole("button", { name: "Done" })).toBeVisible();
    });
  });

  describe("opened with values supplied from outside", () => {
    it("opens a new meeting on a draft's values", () => {
      serveMutations();
      renderWithProviders(
        <MeetingModal
          open
          meeting={null}
          defaultDate={MARCH_15}
          canManage
          draft={{
            title: "Hendricks walkthrough",
            location: "12 Maple Street",
            start_time: new Date(2026, 9, 14, 14, 30).toISOString(),
            end_time: new Date(2026, 9, 14, 15, 15).toISOString(),
            attendee_emails: ["Adjuster@Insurer.com"],
          }}
          onClose={() => {}}
        />,
        { user: OWNER },
      );

      expect(screen.getByLabelText(/^Title/)).toHaveValue("Hendricks walkthrough");
      expect(screen.getByLabelText("Date")).toHaveValue("2026-10-14");
      expect(screen.getByLabelText("Start")).toHaveValue("14:30");
      expect(screen.getByLabelText("End")).toHaveValue("15:15");
      expect(within(screen.getByRole("list", { name: "Guests" })).getByText("adjuster@insurer.com")).toBeVisible();
      // Still an ordinary form: this is how a proposal is handed over to be finished by hand.
      expect(screen.getByRole("button", { name: "Create meeting" })).toBeEnabled();
    });

    it("lets a draft override the meeting being edited, field by field", () => {
      serveMutations();
      renderWithProviders(
        <MeetingModal
          open
          meeting={existing()}
          defaultDate={MARCH_15}
          canManage
          draft={{ start_time: new Date(2026, 2, 15, 16, 0).toISOString() }}
          onClose={() => {}}
        />,
        { user: OWNER },
      );

      expect(screen.getByLabelText("Start")).toHaveValue("16:00");
      expect(screen.getByLabelText(/^Title/)).toHaveValue("Site walkthrough");
      expect(screen.getByLabelText("End")).toHaveValue("10:00");
    });
  });

  describe("staged by the assistant", () => {
    function renderStaged(attendees: { label: string; note?: string }[]) {
      serveMutations();
      return renderWithProviders(
        <MeetingModal
          open
          meeting={null}
          defaultDate={MARCH_15}
          canManage
          draft={{ title: "Hendricks walkthrough" }}
          staged={{ attendees }}
          onClose={() => {}}
        />,
        { user: OWNER },
      );
    }

    it("shows every attendee it was given, from the labels alone", async () => {
      // The roster served here is the owner and one member. Neither Dana, who has been
      // removed, nor the outside guest is on it; a form drawn from the roster would
      // show fewer people than the proposal invites.
      renderStaged([
        { label: "Sam Member" },
        { label: "Dana Removed", note: "removed from the team" },
        { label: "adjuster@insurer.com", note: "outside guest" },
      ]);

      const people = within(screen.getByRole("list", { name: "Attendees" }));
      expect(people.getByText("Sam Member")).toBeVisible();
      expect(people.getByText("Dana Removed")).toBeVisible();
      expect(people.getByText("(removed from the team)")).toBeVisible();
      expect(people.getByText("adjuster@insurer.com")).toBeVisible();
      await waitFor(() => expect(screen.queryAllByRole("checkbox")).toHaveLength(0));
    });

    it("says so when nobody is invited", () => {
      renderStaged([]);

      expect(screen.getByText("Nobody is invited.")).toBeVisible();
    });

    it("is read-only and offers nothing to save or add with", () => {
      renderStaged([{ label: "Sam Member" }]);

      expect(screen.getByText("Filled in by BuildCo Assistant. Not saved yet.")).toBeVisible();
      expect(screen.getByLabelText(/^Title/)).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Create meeting" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Invite by email")).not.toBeInTheDocument();
    });
  });

  it("keeps a rejected save on screen with the values intact", async () => {
    serveMutations();
    server.use(
      http.post(url("/meetings"), () => apiError(403, "forbidden", "Requires role: owner, admin")),
    );

    const { user } = renderModal();
    await user.type(screen.getByLabelText(/^Title/), "Walkthrough");
    await user.click(screen.getByRole("button", { name: "Create meeting" }));

    expect(await screen.findByText("Requires role: owner, admin")).toBeVisible();
    expect(screen.getByLabelText(/^Title/)).toHaveValue("Walkthrough");
  });
});
