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
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import { useCreateMeeting, useDeleteMeeting, useUpdateMeeting } from "@/api/queries/meetings";
import { useProjects } from "@/api/queries/projects";
import { useAssignableUsers } from "@/api/queries/users";
import { useAuth } from "@/auth/useAuth";
import type { MeetingOut, MeetingUpdate } from "@/api/types";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Modal } from "@/components/Modal";
import { Alert } from "@/components/feedback";
import { Field, Input, Select, TextField, Textarea } from "@/components/form";
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
import { displayName } from "@/lib/format";

export function MeetingModal({
  open,
  meeting,
  defaultDate,
  defaultRange,
  canManage,
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
  onClose: () => void;
}) {
  const toast = useToast();
  const { googleAccessToken } = useAuth();
  const create = useCreateMeeting();
  const update = useUpdateMeeting();
  const remove = useDeleteMeeting();

  const { data: users } = useAssignableUsers();
  const { data: projects } = useProjects({ limit: 200 });

  const editing = meeting !== null;
  const readOnly = !canManage;

  const [title, setTitle] = useState(meeting?.title ?? "");
  const [description, setDescription] = useState(meeting?.description ?? "");
  const [location, setLocation] = useState(meeting?.location ?? "");
  const [date, setDate] = useState(
    meeting ? toDateInput(meeting.start_time) : localDayKey(defaultRange?.start ?? defaultDate),
  );
  const [startTime, setStartTime] = useState(
    meeting
      ? toTimeInput(meeting.start_time)
      : defaultRange
        ? toTimeInput(defaultRange.start.toISOString())
        : "09:00",
  );
  const [endTime, setEndTime] = useState(
    meeting
      ? toTimeInput(meeting.end_time)
      : defaultRange
        ? toTimeInput(defaultRange.end.toISOString())
        : "10:00",
  );
  const [color, setColor] = useState(meeting?.color ?? MEETING_COLORS[1]);
  const [projectId, setProjectId] = useState(meeting?.project_id ?? "");
  const [attendees, setAttendees] = useState<string[]>(
    () =>
      (meeting?.attendees ?? [])
        .map((attendee) => attendee.user_id)
        .filter((id): id is string => Boolean(id)),
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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

  async function save() {
    if (!start || !end) return;
    setFailure(null);

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

        if (Object.keys(changes).length === 0) {
          onClose();
          return;
        }

        await update.mutateAsync({ id: meeting.id, body: changes });
        toast.success("Meeting updated.");
      } else {
        await create.mutateAsync({
          title: title.trim(),
          description,
          location,
          start_time: start,
          end_time: end,
          color,
          project_id: projectId || null,
          attendee_ids: attendees,
          // Absent is the normal case, not a degraded one — the meeting is created
          // without a Meet link and everything else works.
          google_access_token: googleAccessToken,
        });
        toast.success(
          googleAccessToken
            ? "Meeting created and invites sent."
            : "Meeting created. Sign in with Google to add a Meet link.",
        );
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

          <div className="grid gap-4 sm:grid-cols-3">
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
            <div className="mt-1.5 flex flex-wrap gap-1.5">
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
          </fieldset>

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

          {!editing && !googleAccessToken && (
            <p className="text-xs text-gray-500">
              No Google Meet link will be added — that needs a Google sign-in with calendar
              access. The meeting and its invites work regardless.
            </p>
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
