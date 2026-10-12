/**
 * Creating and editing a meeting.
 *
 * Date and time are two fields rather than one `datetime-local`, matching the legacy
 * form and because a separate time field is far easier to use on a phone. They are
 * recombined by `fromDateTimeInputs`, which composes them as **local** time — the whole
 * timezone hazard of this screen lives in that one function, and it is tested.
 *
 * Updating sends only what changed. `MeetingUpdate` is a partial, and the backend
 * re-invites attendees **only on a material change** — time, location, title or the
 * attendee list. Sending the whole object every time would re-invite the team for a
 * colour change, which is what trained people to ignore the legacy invites.
 *
 * Attendees come in two kinds. **Team members** are ticked from the roster and sent as
 * `attendee_ids`. **Guests** are anyone else, typed by address and sent as
 * `attendee_emails` — an adjuster, a homeowner, a subcontractor. Both get the same
 * email and .ics; a guest simply has no account, so they never see it in the app. The
 * two lists are independent on the wire, so changing one never resends the other.
 *
 * A **Google Meet link** is opt-in, and only when creating. Ticking the box is what asks
 * Google for calendar access — it is never asked for at sign-in — and the box stays
 * unticked unless that access is given, so what it shows is what the invite will carry.
 */
import { useEffect, useId, useState } from "react";
import { ApiError } from "@/api/client";
import { useCreateMeeting, useDeleteMeeting, useUpdateMeeting } from "@/api/queries/meetings";
import { useProjects } from "@/api/queries/projects";
import { useAssignableUsers } from "@/api/queries/users";
import { CalendarAccessError, preloadGoogleIdentity } from "@/auth/googleCalendarAccess";
import { useAuth } from "@/auth/useAuth";
import type { MeetingOut, MeetingUpdate } from "@/api/types";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Modal } from "@/components/Modal";
import { Alert } from "@/components/feedback";
import { Field, Input, Select, TextField, Textarea } from "@/components/form";
import { StagedMark } from "@/components/staged";
import { useToast } from "@/components/Toast";
import { MEETING_COLORS } from "@/domain/enums";
import {
  addHour,
  fromDateTimeInputs,
  localDayKey,
  toDateInput,
  toTimeInput,
} from "@/domain/calendar";
import { cn } from "@/lib/cn";
import { isEmail, normaliseEmail } from "@/lib/email";
import { displayName } from "@/lib/format";

/** Mirrors `MAX_GUESTS` in the API's meeting schema. */
const MAX_GUESTS = 50;

function describeMeetFailure(caught: unknown): string {
  return caught instanceof CalendarAccessError
    ? caught.message
    : "Google Calendar access could not be requested. Try again.";
}

/** The addresses of everyone on a meeting who is not a team member. */
function guestsOf(meeting: MeetingOut | null): string[] {
  return (meeting?.attendees ?? [])
    .filter((attendee) => !attendee.user_id)
    .map((attendee) => normaliseEmail(attendee.email));
}

/**
 * Values to open the form with, in the API's own terms.
 *
 * Anything given here wins over the meeting being edited, so "this meeting, moved to
 * four o'clock" is the meeting plus a draft of two fields.
 */
export interface MeetingDraft {
  title?: string;
  description?: string;
  location?: string;
  /** ISO instants, as the API sends them. */
  start_time?: string;
  end_time?: string;
  color?: string;
  project_id?: string;
  attendee_ids?: string[];
  attendee_emails?: string[];
}

/** One person on a staged meeting, already named by whoever staged it. */
export interface StagedAttendee {
  label: string;
  /** Said beside the name when there is something to say: "outside guest", "removed". */
  note?: string;
}

export function MeetingModal({
  open,
  meeting,
  defaultDate,
  defaultRange,
  canManage,
  draft,
  staged,
  onClose,
}: {
  open: boolean;
  /** Null when creating. */
  meeting: MeetingOut | null;
  /** The day that was clicked, so a new meeting lands where the user expected. */
  defaultDate: Date;
  /**
   * A start and end dragged out on the time grid.
   *
   * Optional and additive rather than replacing `defaultDate`, so the "New meeting"
   * button and the month grid's day cells keep working unchanged — they have a day in
   * mind but no time, which is exactly what `defaultDate` expresses.
   */
  defaultRange?: { start: Date; end: Date };
  canManage: boolean;
  /**
   * Read once, when the form mounts: give the form a `key` to seed it again. Used to
   * show what the assistant proposes, and to hand that proposal over as an ordinary
   * editable form.
   */
  draft?: MeetingDraft;
  /**
   * Set when the assistant is showing what it proposes. The form is read-only, and the
   * people on it are drawn from these labels **and nothing else**.
   *
   * The roster this form normally ticks names against is the browser's own copy, and it
   * leaves out anyone who has been removed. Drawing a proposal from it could show fewer
   * people than the proposal invites. The labels come with the proposal, so what is on
   * screen is exactly who will be on the meeting.
   */
  staged?: { attendees: StagedAttendee[] };
  onClose: () => void;
}) {
  const toast = useToast();
  const { googleAccessToken, googleCalendarAvailable, requestGoogleCalendarAccess } = useAuth();
  const meetHintId = useId();
  const create = useCreateMeeting();
  const update = useUpdateMeeting();
  const remove = useDeleteMeeting();

  const { data: users } = useAssignableUsers();
  const { data: projects } = useProjects({ limit: 200 });

  const editing = meeting !== null;
  const readOnly = !canManage || staged !== undefined;
  const offersMeet = !editing && !readOnly && googleCalendarAvailable;

  // A draft's times win over the meeting's, and either wins over the clicked day.
  const seedStart = draft?.start_time ?? meeting?.start_time;
  const seedEnd = draft?.end_time ?? meeting?.end_time;

  const [title, setTitle] = useState(draft?.title ?? meeting?.title ?? "");
  const [description, setDescription] = useState(
    draft?.description ?? meeting?.description ?? "",
  );
  const [location, setLocation] = useState(draft?.location ?? meeting?.location ?? "");
  const [date, setDate] = useState(
    seedStart ? toDateInput(seedStart) : localDayKey(defaultRange?.start ?? defaultDate),
  );
  const [startTime, setStartTime] = useState(
    seedStart
      ? toTimeInput(seedStart)
      : defaultRange
        ? toTimeInput(defaultRange.start.toISOString())
        : "09:00",
  );
  const [endTime, setEndTime] = useState(
    seedEnd
      ? toTimeInput(seedEnd)
      : defaultRange
        ? toTimeInput(defaultRange.end.toISOString())
        : "10:00",
  );
  const [color, setColor] = useState(draft?.color ?? meeting?.color ?? MEETING_COLORS[1]);
  const [projectId, setProjectId] = useState(draft?.project_id ?? meeting?.project_id ?? "");
  const [attendees, setAttendees] = useState<string[]>(
    () =>
      draft?.attendee_ids ??
      (meeting?.attendees ?? [])
        .map((attendee) => attendee.user_id)
        .filter((id): id is string => Boolean(id)),
  );
  const [guests, setGuests] = useState<string[]>(
    () => draft?.attendee_emails?.map(normaliseEmail) ?? guestsOf(meeting),
  );
  const [guestDraft, setGuestDraft] = useState("");
  const [guestError, setGuestError] = useState<string | null>(null);
  const [wantsMeet, setWantsMeet] = useState(false);
  const [meetPending, setMeetPending] = useState(false);
  const [meetError, setMeetError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Fetched ahead of the tick, so the popup opens inside the click and is not blocked.
  // A failure here is reported when the box is ticked, which tries again.
  useEffect(() => {
    if (open && offersMeet) preloadGoogleIdentity().catch(() => {});
  }, [open, offersMeet]);

  const start = fromDateTimeInputs(date, startTime);
  const end = fromDateTimeInputs(date, endTime);
  // Checked here as well as server-side so the button explains itself rather than
  // producing a 422 after a round trip.
  const endsAfterStart = start !== null && end !== null && end > start;
  const valid = title.trim().length > 0 && endsAfterStart;

  function toggleAttendee(id: string) {
    setAttendees((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  /**
   * Fold whatever is in the guest field into the list.
   *
   * Returns the resulting list, or `null` when the field holds something that is not an
   * address. It returns rather than only setting state because saving calls it too: an
   * address typed but never "added" is the easiest way to believe you invited someone
   * you did not, so a save commits the field first and uses the list it gets back.
   */
  function commitGuestDraft(): string[] | null {
    // Pasting "a@x.com, b@y.com" is the natural way to add several at once.
    const typed = guestDraft
      .split(/[\s,;]+/)
      .map(normaliseEmail)
      .filter(Boolean);
    if (typed.length === 0) return guests;

    const bad = typed.find((value) => !isEmail(value));
    if (bad) {
      setGuestError(`"${bad}" is not an email address.`);
      return null;
    }

    const next = [...new Set([...guests, ...typed])];
    if (next.length > MAX_GUESTS) {
      setGuestError(`A meeting can have at most ${MAX_GUESTS} guests.`);
      return null;
    }

    setGuests(next);
    setGuestDraft("");
    setGuestError(null);
    return next;
  }

  function removeGuest(email: string) {
    setGuests((current) => current.filter((value) => value !== email));
  }

  async function toggleMeet(checked: boolean) {
    setMeetError(null);
    if (!checked) {
      setWantsMeet(false);
      return;
    }

    setMeetPending(true);
    try {
      await requestGoogleCalendarAccess();
      setWantsMeet(true);
    } catch (caught) {
      setMeetError(describeMeetFailure(caught));
    } finally {
      setMeetPending(false);
    }
  }

  async function save() {
    if (!start || !end) return;
    const guestList = commitGuestDraft();
    if (guestList === null) return;
    setFailure(null);

    // Asked for again rather than read from state: the access given when the box was
    // ticked lasts about an hour, and a form can sit open longer than that. Normally
    // this returns what is already held and opens nothing.
    let meetToken: string | null = null;
    if (offersMeet && wantsMeet) {
      try {
        meetToken = await requestGoogleCalendarAccess();
      } catch (caught) {
        // Stop here. Creating it anyway would send invites without the link the box
        // promised, and there is no adding one afterwards.
        setWantsMeet(false);
        setMeetError(describeMeetFailure(caught));
        return;
      }
    }

    try {
      if (editing) {
        // Only what changed. A colour-only edit must not re-invite the team.
        const changes: MeetingUpdate = {};
        if (title.trim() !== meeting.title) changes.title = title.trim();
        if (description !== meeting.description) changes.description = description;
        if (location !== meeting.location) changes.location = location;
        if (start !== meeting.start_time) changes.start_time = start;
        if (end !== meeting.end_time) changes.end_time = end;
        if (color !== meeting.color) changes.color = color;
        if ((projectId || null) !== (meeting.project_id ?? null)) {
          changes.project_id = projectId || null;
        }

        const current = (meeting.attendees ?? [])
          .map((attendee) => attendee.user_id)
          .filter((id): id is string => Boolean(id));
        if (current.length !== attendees.length || current.some((id) => !attendees.includes(id))) {
          changes.attendee_ids = attendees;
        }

        const currentGuests = guestsOf(meeting);
        if (
          currentGuests.length !== guestList.length ||
          currentGuests.some((email) => !guestList.includes(email))
        ) {
          changes.attendee_emails = guestList;
        }

        if (Object.keys(changes).length === 0) {
          onClose();
          return;
        }

        await update.mutateAsync({ id: meeting.id, body: changes });
        toast.success("Meeting updated.");
      } else {
        const created = await create.mutateAsync({
          title: title.trim(),
          description,
          location,
          start_time: start,
          end_time: end,
          color,
          project_id: projectId || null,
          attendee_ids: attendees,
          attendee_emails: guestList,
          // Sent only when the box is ticked. A token left in memory by an earlier
          // meeting must not put a Meet link on one that did not ask for it.
          google_access_token: meetToken,
        });
        if (created.meet_link) {
          toast.success("Meeting created with a Google Meet link.");
        } else if (meetToken) {
          // The API never fails a meeting over the link: if Google refuses, the
          // meeting and its invites still go out, so this is the only place to say so.
          toast.info("Meeting created, but Google did not return a Meet link.");
        } else {
          toast.success("Meeting created.");
        }
      }
      onClose();
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : "The meeting could not be saved.");
    }
  }

  async function confirmDelete() {
    if (!meeting) return;
    setConfirmingDelete(false);

    try {
      await remove.mutateAsync({ id: meeting.id, googleAccessToken });
      toast.success("Meeting cancelled. Attendees have been notified.");
      onClose();
    } catch (caught) {
      setFailure(
        caught instanceof ApiError ? caught.message : "The meeting could not be cancelled.",
      );
    }
  }

  const busy = create.isPending || update.isPending;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={editing ? meeting.title || "Meeting" : "New meeting"}
        size="lg"
        staged={staged !== undefined}
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>
              {readOnly ? "Done" : "Cancel"}
            </Button>
            {editing && canManage && (
              <Button
                variant="ghost"
                className="text-danger-600 dark:text-danger-400 hover:bg-danger-50"
                disabled={busy}
                onClick={() => setConfirmingDelete(true)}
              >
                Cancel meeting
              </Button>
            )}
            {canManage && (
              <Button variant="primary" busy={busy} disabled={!valid} onClick={() => void save()}>
                {editing ? "Save changes" : "Create meeting"}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {failure && <Alert tone="danger">{failure}</Alert>}

          {meeting?.meet_link && (
            <Alert tone="info">
              <a
                href={meeting.meet_link}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
              >
                Join the Google Meet
              </a>
            </Alert>
          )}

          <TextField
            label="Title"
            required
            value={title}
            disabled={readOnly}
            placeholder="Site walkthrough"
            onChange={(event) => setTitle(event.target.value)}
          />

          <div className="grid gap-4 app-sm:grid-cols-3">
            <Field label="Date">
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  value={date}
                  disabled={readOnly}
                  onChange={(event) => setDate(event.target.value)}
                />
              )}
            </Field>
            <Field label="Start">
              {(props) => (
                <Input
                  {...props}
                  type="time"
                  value={startTime}
                  disabled={readOnly}
                  onChange={(event) => {
                    setStartTime(event.target.value);
                    // Keep the hour-long default intact while someone is picking a
                    // start; they can still shorten or lengthen it afterwards.
                    if (!editing) setEndTime(addHour(event.target.value));
                  }}
                />
              )}
            </Field>
            <Field
              label="End"
              {...(start && end && !endsAfterStart
                ? { error: "Must be after the start time." }
                : {})}
            >
              {(props) => (
                <Input
                  {...props}
                  type="time"
                  value={endTime}
                  disabled={readOnly}
                  onChange={(event) => setEndTime(event.target.value)}
                />
              )}
            </Field>
          </div>

          <TextField
            label="Location"
            value={location}
            disabled={readOnly}
            placeholder="12 Oak Street"
            onChange={(event) => setLocation(event.target.value)}
          />

          {offersMeet && (
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                <input
                  type="checkbox"
                  checked={wantsMeet}
                  disabled={meetPending}
                  aria-describedby={meetHintId}
                  onChange={(event) => void toggleMeet(event.target.checked)}
                  className="size-4 rounded border-gray-300 text-brand-600 dark:text-brand-300 focus:ring-brand-500"
                />
                Add a Google Meet link
              </label>
              {meetError ? (
                <p id={meetHintId} className="text-xs text-danger-600 dark:text-danger-400">
                  {meetError}
                </p>
              ) : (
                <p id={meetHintId} className="text-xs text-gray-500">
                  {meetPending
                    ? "Waiting for Google…"
                    : wantsMeet
                      ? "The link will be in the invite email and the calendar file."
                      : "Google will ask for access to your calendar. The link goes in the invite email and the calendar file."}
                </p>
              )}
            </div>
          )}

          <Field label="Description">
            {(props) => (
              <Textarea
                {...props}
                rows={3}
                value={description}
                disabled={readOnly}
                onChange={(event) => setDescription(event.target.value)}
              />
            )}
          </Field>

          <Field label="Project">
            {(props) => (
              <Select
                {...props}
                value={projectId ?? ""}
                disabled={readOnly}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">No project</option>
                {(projects?.items ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.owner_name || project.address || "Untitled project"}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <fieldset disabled={readOnly}>
            <legend className="text-sm font-medium text-gray-700">Colour</legend>
            {/* On a staged form the colour is part of what would be saved, so it is
                marked like the fields. Anywhere else this wrapper is not there. */}
            <StagedMark className="mt-1.5">
            <div className={cn("flex flex-wrap gap-1.5", staged === undefined && "mt-1.5")}>
              {MEETING_COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`Colour ${value}`}
                  aria-pressed={color === value}
                  onClick={() => setColor(value)}
                  style={{ backgroundColor: value }}
                  className={cn(
                    "size-6 rounded-full transition-transform",
                    color === value
                      ? "ring-2 ring-gray-900 ring-offset-2"
                      : "hover:scale-110",
                  )}
                />
              ))}
            </div>
            </StagedMark>
          </fieldset>

          {staged ? (
            <StagedAttendees attendees={staged.attendees} />
          ) : (
            <>
          <fieldset disabled={readOnly}>
            <legend className="text-sm font-medium text-gray-700">Attendees</legend>
            <div className="mt-1.5 flex flex-col gap-1">
              {(users ?? []).map((user) => (
                <label key={user.id} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={attendees.includes(user.id)}
                    onChange={() => toggleAttendee(user.id)}
                    className="size-4 rounded border-gray-300 text-brand-600 dark:text-brand-300 focus:ring-brand-500"
                  />
                  {displayName(user)}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              Everyone ticked receives a calendar invite. Changing the list re-sends it;
              changing the colour does not.
            </p>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            {!readOnly && (
              <Field
                label="Invite by email"
                hint="For anyone outside the team. They get the same invite and calendar file."
                error={guestError ?? undefined}
              >
                {(props) => (
                  <div className="flex gap-2">
                    <Input
                      {...props}
                      // Text, not `type="email"`: several addresses can be pasted at
                      // once, and the browser's own email field rewrites such a value.
                      type="text"
                      inputMode="email"
                      autoComplete="off"
                      placeholder="adjuster@insurer.com"
                      value={guestDraft}
                      onChange={(event) => {
                        setGuestDraft(event.target.value);
                        setGuestError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        // Enter adds the guest; it must not fall through to anything
                        // that would close or submit the dialog.
                        event.preventDefault();
                        commitGuestDraft();
                      }}
                    />
                    <Button
                      className="shrink-0"
                      disabled={guestDraft.trim().length === 0}
                      onClick={() => commitGuestDraft()}
                    >
                      Add
                    </Button>
                  </div>
                )}
              </Field>
            )}

            {readOnly && guests.length > 0 && (
              <p className="text-sm font-medium text-gray-700">Guests</p>
            )}

            {guests.length > 0 && (
              <ul aria-label="Guests" className="flex flex-wrap gap-1.5">
                {guests.map((email) => (
                  <li
                    key={email}
                    className="inline-flex items-center gap-1 rounded-full bg-gray-100 py-0.5 pr-1 pl-2.5 text-xs text-gray-700 ring-1 ring-inset ring-gray-200"
                  >
                    {email}
                    {!readOnly && (
                      <button
                        type="button"
                        aria-label={`Remove ${email}`}
                        onClick={() => removeGuest(email)}
                        className="rounded-full px-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
            </>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmingDelete}
        title="Cancel this meeting?"
        confirmLabel="Cancel meeting"
        cancelLabel="Keep it"
        busy={remove.isPending}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => void confirmDelete()}
      >
        <p>
          <strong>{meeting?.title}</strong> will be removed and everyone invited will receive a
          cancellation.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** Who a staged meeting invites, as plain text. Nothing here can be ticked or removed. */
function StagedAttendees({ attendees }: { attendees: StagedAttendee[] }) {
  return (
    <div>
      <p className="text-sm font-medium text-gray-700">Attendees</p>
      {attendees.length === 0 ? (
        <p className="mt-1.5 text-sm text-gray-500">Nobody is invited.</p>
      ) : (
        <StagedMark className="mt-1.5">
          <ul aria-label="Attendees" className="flex flex-col gap-1">
            {attendees.map((attendee) => (
              <li key={attendee.label} className="text-sm text-gray-900">
                {attendee.label}
                {attendee.note && <span className="text-gray-500"> ({attendee.note})</span>}
              </li>
            ))}
          </ul>
        </StagedMark>
      )}
    </div>
  );
}
