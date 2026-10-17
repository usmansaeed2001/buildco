"""BuildCo Assistant: the decisions that must not be left to the model.

A voice model can be talked into things, mishears, and treats its instructions as
advice. So every decision with a consequence is made here, as data in and decision out,
and enforced by the server whatever the model says or does:

* who is offered the assistant at all;
* whether a proposal may be approved by voice or needs a click;
* whether a spoken "yes" actually counts;
* the words of the read-back, and what must be heard in it;
* how much of the day's allowance is left.

Pure functions. No session, no clock, no network: the whole matrix runs in milliseconds.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from app.models.enums import AgentActionStatus, AgentApprovalPolicy
from app.services.rules import agent_readback as readback

# ── What can be proposed ──────────────────────────────────────────────────────

MEETING_CREATE = "meeting.create"
MEETING_UPDATE = "meeting.update"
SUPPLEMENT_CREATE = "supplement.create"
SUPPLEMENT_UPDATE = "supplement.update_details"
SUPPLEMENT_TRANSITION = "supplement.transition"
SUPPLEMENT_SUBMIT = "supplement.submit"
SUPPLEMENT_ADD_LINES = "supplement.add_lines"
MEMORY_CHANGE = "memory.change"

#: Every kind of proposal there is. **None of them deletes a record**, and a test
#: fails if one that does is added.
KINDS: frozenset[str] = frozenset(
    {
        MEETING_CREATE,
        MEETING_UPDATE,
        SUPPLEMENT_CREATE,
        SUPPLEMENT_UPDATE,
        SUPPLEMENT_TRANSITION,
        SUPPLEMENT_SUBMIT,
        SUPPLEMENT_ADD_LINES,
        MEMORY_CHANGE,
    }
)

#: Status changes that alter who can edit a supplement, or that approve it. A click.
CLICK_ONLY_TRANSITIONS: frozenset[str] = frozenset({"lock", "unlock", "admin_approve"})

#: At most this many memories per person.
MEMORY_LIMIT = 100

# ── Who gets the assistant ────────────────────────────────────────────────────


def offered_to(email: str, *, enabled: bool, audience: str, pilot_emails: Sequence[str]) -> bool:
    """Whether this person is offered the assistant.

    **Fails closed.** While the audience is ``pilot`` only the listed addresses qualify,
    and an empty list means nobody. ``everyone`` has to be set explicitly. A variable
    forgotten in a new environment therefore gives the assistant to no one, not to the
    whole team.
    """
    if not enabled:
        return False
    if audience == "everyone":
        return True
    return email.strip().lower() in {listed.strip().lower() for listed in pilot_emails}


# ── Voice, or a click ─────────────────────────────────────────────────────────


def meeting_approval_policy(*, emails_anyone: bool) -> AgentApprovalPolicy:
    """A meeting that emails anybody needs a click; one that emails nobody does not.

    Anything outward-facing is click-only. An invite cannot be unsent, and a spoken
    "yes" can come from a bystander, an echo, or a mishearing.
    """
    return AgentApprovalPolicy.CLICK if emails_anyone else AgentApprovalPolicy.VOICE_OR_CLICK


def approval_policy(
    kind: str, *, emails_anyone: bool = False, transition: str | None = None
) -> AgentApprovalPolicy:
    """Whether a proposal of this kind may be approved by voice, or needs a click.

    A click for anything outward-facing, and for anything that changes who can edit a
    supplement or approves one. Voice or a click for the rest. An unknown kind gets a
    click: the cautious answer is the default, not the exception.
    """
    if kind in (MEETING_CREATE, MEETING_UPDATE):
        return meeting_approval_policy(emails_anyone=emails_anyone)
    if kind == SUPPLEMENT_SUBMIT:
        return AgentApprovalPolicy.CLICK
    if kind == SUPPLEMENT_TRANSITION:
        if transition is None or transition in CLICK_ONLY_TRANSITIONS:
            return AgentApprovalPolicy.CLICK
        return AgentApprovalPolicy.VOICE_OR_CLICK
    if kind in (SUPPLEMENT_CREATE, SUPPLEMENT_UPDATE, SUPPLEMENT_ADD_LINES, MEMORY_CHANGE):
        return AgentApprovalPolicy.VOICE_OR_CLICK
    return AgentApprovalPolicy.CLICK


# ── Whether a spoken yes counts ───────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class VoiceCommitFacts:
    """What the server knows at the moment the model asks to commit by voice.

    Offsets are seconds into the microphone audio the server has received. Nothing is
    compared against a clock: the browser reports "the read-back finished playing" on
    the same socket as the audio, so its position in that stream is exact.
    """

    #: The proposal exists, and belongs to this conversation.
    in_this_conversation: bool
    status: AgentActionStatus
    expired: bool
    policy: AgentApprovalPolicy
    #: Where the microphone stream stood when the read-back finished playing. ``None``
    #: if it never did, which includes a read-back the user interrupted.
    readback_played_at: float | None
    #: Where the user's most recent utterance began.
    last_utterance_began_at: float | None
    #: Whether the user typed something after the read-back finished.
    typed_after_readback: bool
    #: Whether the essentials and every exception were found in what the agent said.
    readback_verified: bool = True


#: Reasons a voice commit is refused. The value is also what the model is told to say.
REFUSALS: dict[str, str] = {
    "unknown": "There is no such proposal in this conversation.",
    "not_open": "That proposal is no longer open, so there is nothing to approve.",
    "expired": "That proposal has expired. Propose it again if it is still wanted.",
    "click_only": (
        "This one cannot be approved by voice. Ask the user to press Approve when they are ready."
    ),
    "readback_not_finished": (
        "The user has not heard the whole read-back yet. Read it again in full, or ask "
        "them to press Approve."
    ),
    "answered_too_early": (
        "The user's answer began before the read-back had finished, so it cannot count. "
        "Ask them again now, or ask them to press Approve."
    ),
    "readback_unverified": (
        "Part of the summary was not spoken, so this one cannot be approved by voice. "
        "Ask the user to check the card on screen and press Approve."
    ),
}


def refuse_voice_commit(facts: VoiceCommitFacts) -> str | None:
    """Why this voice commit must be refused, as a key of ``REFUSALS``, or ``None``.

    The model is told never to commit before the user has heard the read-back and said
    yes. In testing it committed on a "yes" that interrupted the read-back every time.
    So the rule is enforced here, on facts the model does not control:

    * the read-back **finished playing** on the user's device; and
    * the approving utterance **began after** that moment, or the user typed after it.

    Speech that started earlier, speech over the agent's own voice, and an interruption
    of the read-back all fail the second test, because their start offset is smaller.

    The order of the checks is the order in which each stops being worth explaining.
    """
    if not facts.in_this_conversation:
        return "unknown"
    if facts.status is not AgentActionStatus.PROPOSED:
        return "not_open"
    if facts.expired:
        return "expired"
    if facts.policy is not AgentApprovalPolicy.VOICE_OR_CLICK:
        return "click_only"
    if not facts.readback_verified:
        return "readback_unverified"
    if facts.readback_played_at is None:
        return "readback_not_finished"
    if facts.typed_after_readback:
        return None
    began = facts.last_utterance_began_at
    if began is None or began <= facts.readback_played_at:
        return "answered_too_early"
    return None


# ── The read-back ─────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Invitee:
    label: str
    #: For someone outside the team, the address, which is read out spelled.
    outside_email: str | None = None


def describe_when(start: datetime, end: datetime) -> str:
    """A meeting's time as it is said aloud: weekday, full date, time, and length.

    ``start`` and ``end`` are already in the user's own zone. The weekday is there
    because "the fourteenth" is easy to mishear and "Wednesday the fourteenth" is not.
    """
    minutes = int((end - start).total_seconds() // 60)
    hours, rest = divmod(minutes, 60)
    if hours and rest:
        length = f"{hours} hour{'s' if hours != 1 else ''} {rest} minutes"
    elif hours:
        length = f"{hours} hour{'s' if hours != 1 else ''}"
    else:
        length = f"{rest} minutes"
    clock = start.strftime("%I:%M %p").lstrip("0")
    return f"{start.strftime('%A')}, {start.day} {start.strftime('%B %Y')} at {clock}, for {length}"


def meeting_summary(
    *, title: str, start: datetime, end: datetime, location: str, invitees: Sequence[Invitee]
) -> str:
    """The read-back for a new meeting, written from the values that will be saved.

    The model is given this to speak. It is also shown word for word on the approval
    card, and the card is what is being approved: a voice model paraphrases, so the
    text on screen is the authority and this is its spoken companion.

    It always names the meeting and when it is, and always says who will be emailed.
    """
    parts = [f"I am about to create the meeting {title} on {describe_when(start, end)}."]
    if location:
        parts.append(f"Location: {location}.")
    if not invitees:
        parts.append("Nobody is invited, so no email will be sent.")
    else:
        team = [person.label for person in invitees if person.outside_email is None]
        outside = [person.outside_email for person in invitees if person.outside_email]
        if team:
            parts.append(f"{_listed(team)} will be emailed an invite.")
        if outside:
            noun = "An outside guest" if len(outside) == 1 else "Outside guests"
            parts.append(f"{noun} will also be emailed: {_listed(outside)}.")
    return " ".join(parts)


def _listed(items: Sequence[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} and {items[-1]}"


# ── What must be heard ────────────────────────────────────────────────────────

Term = dict[str, Any]


def money(amount: Decimal | float | int | str) -> str:
    return f"${Decimal(str(amount)):,.2f}"


def memory_note(fields: Sequence[str]) -> str:
    """The sentence that owns up to values the user did not say this time."""
    if not fields:
        return ""
    verb = "comes" if len(fields) == 1 else "come"
    return f"The {_listed(list(fields))} {verb} from what I remember about you."


def _memory_terms(fields: Sequence[str]) -> list[Term]:
    if not fields:
        return []
    return [readback.any_term("that a value came from memory", ["remember", "memory"])]


def meeting_terms(
    *, title: str, start: datetime, invitees: Sequence[Invitee], remembered: Sequence[str] = ()
) -> list[Term]:
    """What must be heard for a meeting: which one, when, and every outside address."""
    terms: list[Term] = [
        readback.text_term("the meeting's title", title),
        readback.date_term("the meeting's date", month=start.month, day=start.day),
        readback.time_term("the meeting's time", hour=start.hour, minute=start.minute),
    ]
    terms += [
        readback.email_term("an outside guest's address", person.outside_email)
        for person in invitees
        if person.outside_email
    ]
    return terms + _memory_terms(remembered)


def supplement_name(*, project_name: str, client_name: str, identifier: str) -> str:
    """How a supplement is named aloud: by project, with its claim id."""
    name = project_name.strip() or client_name.strip()
    if name and identifier:
        return f"{name}, claim ID {identifier}"
    return name or (f"claim ID {identifier}" if identifier else "the unnamed supplement")


def supplement_terms(
    *, project_name: str, client_name: str, identifier: str, total: Decimal | None = None
) -> list[Term]:
    """What must be heard for a supplement: which one, and its total where it has one."""
    names = [value for value in (project_name.strip(), client_name.strip(), identifier) if value]
    terms: list[Term] = []
    if names:
        terms.append(readback.any_term("which supplement", names))
    if total is not None and total > 0:
        terms.append(readback.amount_term("the supplement's total", total))
    return terms


# ── More read-backs ───────────────────────────────────────────────────────────


def _who_is_emailed(invitees: Sequence[Invitee], *, what: str) -> list[str]:
    team = [person.label for person in invitees if person.outside_email is None]
    outside = [person.outside_email for person in invitees if person.outside_email]
    parts = []
    if team:
        parts.append(f"{_listed(team)} will be emailed {what}.")
    if outside:
        noun = "An outside guest" if len(outside) == 1 else "Outside guests"
        parts.append(f"{noun} will also be emailed: {_listed(outside)}.")
    return parts


def meeting_update_summary(
    *,
    title: str,
    start: datetime,
    end: datetime,
    changes: Sequence[str],
    invitees: Sequence[Invitee],
    reinvites: bool,
    dropped: Sequence[str] = (),
) -> str:
    """The read-back for a change to a meeting.

    Always says when the meeting will be, changed or not: an approval of "the Hendricks
    walkthrough" rests on the user having heard which one.
    """
    parts = [f"I am about to change the meeting {title}."]
    parts.extend(changes)
    parts.append(f"It will be on {describe_when(start, end)}.")
    for name in dropped:
        parts.append(f"{name} has been removed from the team and will come off this meeting.")
    if reinvites and invitees:
        parts.extend(_who_is_emailed(invitees, what="an updated invite"))
    else:
        parts.append("No email will be sent.")
    return " ".join(parts)


def supplement_create_summary(
    *,
    project_name: str,
    client_name: str,
    identifier: str | None,
    pm_name: str,
    insurance_carrier: str,
    remembered: Sequence[str] = (),
) -> str:
    parts = [f"I am about to create a supplement for {project_name or client_name}."]
    if project_name and client_name:
        parts.append(f"Client: {client_name}.")
    parts.append(
        f"Claim ID: {identifier}." if identifier else "A claim ID will be generated for it."
    )
    if pm_name:
        parts.append(f"Project manager: {pm_name}.")
    if insurance_carrier:
        parts.append(f"Carrier: {insurance_carrier}.")
    parts.append("It starts with no rooms or lines.")
    note = memory_note(remembered)
    if note:
        parts.append(note)
    return " ".join(parts)


@dataclass(frozen=True, slots=True)
class FieldChange:
    label: str
    old: str
    new: str


def supplement_update_summary(
    *, name: str, changes: Sequence[FieldChange], status_note: str = ""
) -> str:
    parts = [f"I am about to change the details of the supplement {name}."]
    for change in changes:
        was = f"from {change.old} " if change.old else ""
        parts.append(f"{change.label}: {was}to {change.new or 'blank'}.")
    if status_note:
        parts.append(status_note)
    return " ".join(parts)


#: How each status change is said, and what else the user should know about it.
TRANSITION_WORDS: dict[str, tuple[str, str]] = {
    "archive": ("archive", ""),
    "unarchive": ("return to the active list", ""),
    "lock": ("lock", "Only an owner will be able to edit it, and the admins will be emailed."),
    "unlock": ("unlock", "It will be open for editing again."),
    "recall": ("recall from review", "The reviewer's link will stop working."),
    "resubmit_ready": ("reopen for editing", "The reviewer's link will stop working."),
    "admin_approve": ("approve internally", "It will be marked approved without the reviewer."),
}


def said_status(status: str) -> str:
    return status.replace("_", " ")


def supplement_transition_summary(*, name: str, action: str, status: str, total: Decimal) -> str:
    verb, note = TRANSITION_WORDS.get(action, (action.replace("_", " "), ""))
    parts = [
        f"I am about to {verb} the supplement {name}, which is currently {said_status(status)}."
    ]
    if total > 0:
        parts.append(f"Its total is {money(total)}.")
    if note:
        parts.append(note)
    return " ".join(parts)


def supplement_submit_summary(
    *, name: str, total: Decimal, reviewer_name: str, reviewer_email: str
) -> str:
    return (
        f"I am about to send the supplement {name} for review. Its total is {money(total)}. "
        f"{reviewer_name} will be emailed the approval link at {reviewer_email}."
    )


@dataclass(frozen=True, slots=True)
class AddedLine:
    room: str
    new_room: bool
    name: str
    unit_cost: Decimal
    #: ``catalogue``, ``stated`` or ``differs``, as ``line_additions`` decides.
    source: str
    catalogue_unit_cost: Decimal | None = None


def _counted(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


def supplement_add_lines_summary(
    *,
    name: str,
    lines: Sequence[AddedLine],
    old_total: Decimal,
    new_total: Decimal,
    status_note: str = "",
) -> str:
    """The read-back for lines added to a supplement: how many, where, and the total.

    Not a recital of every line: those are on screen. What is always said is each line
    whose price did not come from the catalogue, because that price is the user's word
    and not the team's rate.
    """
    per_room: dict[str, tuple[int, bool]] = {}
    for line in lines:
        count, new = per_room.get(line.room, (0, line.new_room))
        per_room[line.room] = (count + 1, new)
    where = [
        f"{count} to {'a new room, ' if new else ''}{room}"
        for room, (count, new) in per_room.items()
    ]
    parts = [
        f"I am about to add {_counted(len(lines), 'line')} to the supplement {name}: "
        f"{_listed(where)}.",
        f"The total goes from {money(old_total)} to {money(new_total)}.",
    ]
    for line in lines:
        if line.source == "stated":
            parts.append(
                f"{line.name} is at {money(line.unit_cost)}, the price you gave; it is not "
                "from the catalogue."
            )
        elif line.source == "differs" and line.catalogue_unit_cost is not None:
            parts.append(
                f"{line.name} is at {money(line.unit_cost)}, the price you gave; the "
                f"catalogue has {money(line.catalogue_unit_cost)}."
            )
    if status_note:
        parts.append(status_note)
    return " ".join(parts)


def add_lines_terms(
    *, record: Sequence[Term], lines: Sequence[AddedLine], new_total: Decimal
) -> list[Term]:
    """What must be heard: which supplement, the new total, and every price not from
    the catalogue."""
    terms = [*record, readback.amount_term("the supplement's new total", new_total)]
    terms += [
        readback.amount_term("a price that is not from the catalogue", line.unit_cost)
        for line in lines
        if line.source != "catalogue"
    ]
    return terms


def memory_change_summary(*, old: str, new: str | None) -> str:
    if new is None:
        return f"I am about to forget this: {old}"
    return f"I am about to change what I remember, from: {old} To: {new}"


# ── The daily allowance ───────────────────────────────────────────────────────


def day_start(now: datetime) -> datetime:
    """00:00 UTC of the day ``now`` falls in. The allowance is counted from here.

    One instant for the whole team, on the server's clock. Never anything the browser
    reports, so it cannot be moved by changing a device's time zone.
    """
    return now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)


def next_reset(now: datetime) -> datetime:
    return day_start(now) + timedelta(days=1)


def daily_limit_seconds(team_minutes: int | None, default_minutes: int) -> int:
    """The allowance in force. The team's own figure wins, **zero included**.

    Zero is not "unset": it is the off switch. Only a figure the team has never set
    falls back to the default.
    """
    minutes = default_minutes if team_minutes is None else team_minutes
    return max(0, minutes) * 60


def remaining_seconds(limit_seconds: int, used_seconds: int) -> int:
    return max(0, limit_seconds - max(0, used_seconds))


# ── Timers ────────────────────────────────────────────────────────────────────


def idle_state(
    *, quiet_for: float, warning_after: float, timeout_after: float, paused: bool
) -> str:
    """``ok``, ``warn`` or ``end``, from how long the user has been silent.

    The clock that feeds ``quiet_for`` does not run while the agent is speaking or a
    proposal is waiting, so this only ever judges real silence. A conversation paused
    for an approval is never idle.
    """
    if paused:
        return "ok"
    if quiet_for >= timeout_after:
        return "end"
    if quiet_for >= warning_after:
        return "warn"
    return "ok"
