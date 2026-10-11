"""BuildCo Assistant: the decisions that must not be left to the model.

A voice model can be talked into things, mishears, and treats its instructions as
advice. So every decision with a consequence is made here, as data in and decision out,
and enforced by the server whatever the model says or does:

* who is offered the assistant at all;
* whether a proposal may be approved by voice or needs a click;
* whether a spoken "yes" actually counts;
* the words of the read-back.

Pure functions. No session, no clock, no network: the whole matrix runs in milliseconds.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from app.models.enums import AgentActionStatus, AgentApprovalPolicy

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
