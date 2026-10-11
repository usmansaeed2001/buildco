"""BuildCo Assistant: the decisions the model is not trusted with.

Each of these is a small pure function, which is exactly why they get a full matrix: the
whole point of taking a decision away from the model is that it is then decided the same
way every time, and a gap here is a gap in the one place that was supposed to be solid.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.models.enums import AgentActionStatus, AgentApprovalPolicy
from app.services.rules import agent_rules
from app.services.rules.agent_rules import Invitee, VoiceCommitFacts

# ── Who gets the assistant ────────────────────────────────────────────────────


def offered(email="sam@buildco.example", **overrides):
    settings = {"enabled": True, "audience": "pilot", "pilot_emails": ["sam@buildco.example"]}
    return agent_rules.offered_to(email, **{**settings, **overrides})


def test_someone_on_the_pilot_list_is_offered_it():
    assert offered()


def test_someone_not_on_the_pilot_list_is_not():
    assert not offered("other@buildco.example")


def test_an_empty_pilot_list_means_nobody():
    """Fails closed. A variable forgotten in a new environment must not open it to all."""
    assert not offered(pilot_emails=[])


def test_the_pilot_list_is_matched_without_regard_to_case_or_padding():
    assert offered(" Sam@BuildCo.example ", pilot_emails=["SAM@buildco.example "])


def test_everyone_means_everyone_and_ignores_the_list():
    assert offered("other@buildco.example", audience="everyone", pilot_emails=[])


@pytest.mark.parametrize("audience", ["pilot", "everyone"])
def test_switched_off_means_nobody_whatever_the_audience(audience):
    assert not offered(enabled=False, audience=audience)


# ── Voice, or a click ─────────────────────────────────────────────────────────


def test_a_meeting_that_emails_nobody_may_be_approved_by_voice():
    policy = agent_rules.meeting_approval_policy(emails_anyone=False)

    assert policy is AgentApprovalPolicy.VOICE_OR_CLICK


def test_a_meeting_that_emails_anyone_needs_a_click():
    assert agent_rules.meeting_approval_policy(emails_anyone=True) is AgentApprovalPolicy.CLICK


# ── Whether a spoken yes counts ───────────────────────────────────────────────

#: Everything in order: the read-back finished at 40s and the user answered at 41s.
GOOD = VoiceCommitFacts(
    in_this_conversation=True,
    status=AgentActionStatus.PROPOSED,
    expired=False,
    policy=AgentApprovalPolicy.VOICE_OR_CLICK,
    readback_played_at=40.0,
    last_utterance_began_at=41.0,
    typed_after_readback=False,
)


def test_a_yes_that_began_after_the_readback_finished_counts():
    assert agent_rules.refuse_voice_commit(GOOD) is None


def test_a_yes_that_began_before_the_readback_finished_does_not():
    """The case seen every time in testing: a yes that interrupts the read-back."""
    early = replace(GOOD, last_utterance_began_at=12.0)

    assert agent_rules.refuse_voice_commit(early) == "answered_too_early"


def test_a_yes_at_the_very_instant_the_readback_finished_does_not_count():
    """Strictly after. On the boundary the user cannot have heard the last word."""
    assert (
        agent_rules.refuse_voice_commit(replace(GOOD, last_utterance_began_at=40.0))
        == "answered_too_early"
    )


def test_no_yes_counts_until_the_readback_has_finished_playing():
    """Covers a read-back the user interrupted: it never finishes, so it is never reported."""
    unheard = replace(GOOD, readback_played_at=None)

    assert agent_rules.refuse_voice_commit(unheard) == "readback_not_finished"


def test_with_no_utterance_on_record_there_is_nothing_to_count():
    assert (
        agent_rules.refuse_voice_commit(replace(GOOD, last_utterance_began_at=None))
        == "answered_too_early"
    )


def test_typing_after_the_readback_counts_without_any_speech():
    typed = replace(GOOD, last_utterance_began_at=None, typed_after_readback=True)

    assert agent_rules.refuse_voice_commit(typed) is None


def test_typing_does_not_get_round_a_readback_that_never_finished():
    typed = replace(GOOD, readback_played_at=None, typed_after_readback=True)

    assert agent_rules.refuse_voice_commit(typed) == "readback_not_finished"


def test_a_click_only_proposal_cannot_be_approved_by_voice_at_all():
    """However good the timing. Saying yes, or typing it, does not approve these."""
    click_only = replace(GOOD, policy=AgentApprovalPolicy.CLICK, typed_after_readback=True)

    assert agent_rules.refuse_voice_commit(click_only) == "click_only"


@pytest.mark.parametrize(
    "status",
    [status for status in AgentActionStatus if status is not AgentActionStatus.PROPOSED],
)
def test_only_an_open_proposal_can_be_committed(status):
    assert agent_rules.refuse_voice_commit(replace(GOOD, status=status)) == "not_open"


def test_an_expired_proposal_is_refused():
    assert agent_rules.refuse_voice_commit(replace(GOOD, expired=True)) == "expired"


def test_a_proposal_from_somewhere_else_is_refused_first():
    stranger = replace(GOOD, in_this_conversation=False, policy=AgentApprovalPolicy.CLICK)

    assert agent_rules.refuse_voice_commit(stranger) == "unknown"


def test_every_refusal_has_something_for_the_model_to_say():
    reasons = {
        agent_rules.refuse_voice_commit(facts)
        for facts in (
            replace(GOOD, in_this_conversation=False),
            replace(GOOD, status=AgentActionStatus.COMMITTED),
            replace(GOOD, expired=True),
            replace(GOOD, policy=AgentApprovalPolicy.CLICK),
            replace(GOOD, readback_played_at=None),
            replace(GOOD, last_utterance_began_at=1.0),
        )
    }

    assert reasons == set(agent_rules.REFUSALS)


# ── The read-back ─────────────────────────────────────────────────────────────

PACIFIC = ZoneInfo("America/Los_Angeles")
START = datetime(2026, 10, 14, 14, 30, tzinfo=PACIFIC)


def summary(**overrides):
    values = {
        "title": "Hendricks walkthrough",
        "start": START,
        "end": START + timedelta(minutes=45),
        "location": "",
        "invitees": [],
    }
    return agent_rules.meeting_summary(**{**values, **overrides})


def test_the_readback_names_the_meeting_and_says_when_with_the_weekday():
    assert summary().startswith(
        "I am about to create the meeting Hendricks walkthrough on Wednesday, 14 October "
        "2026 at 2:30 PM, for 45 minutes."
    )


def test_the_readback_says_so_when_nobody_will_be_emailed():
    assert "Nobody is invited, so no email will be sent." in summary()


def test_the_readback_names_everyone_who_will_be_emailed():
    text = summary(invitees=[Invitee("Mia Member"), Invitee("Sam Second")])

    assert "Mia Member and Sam Second will be emailed an invite." in text


def test_the_readback_calls_out_an_outside_guest_by_address():
    guest = Invitee("adjuster@insurer.example.com", outside_email="adjuster@insurer.example.com")

    text = summary(invitees=[Invitee("Mia Member"), guest])

    assert "Mia Member will be emailed an invite." in text
    assert "An outside guest will also be emailed: adjuster@insurer.example.com." in text


def test_the_readback_includes_a_location_only_when_there_is_one():
    assert "Location:" not in summary()
    assert "Location: 12 Maple Street." in summary(location="12 Maple Street")


@pytest.mark.parametrize(
    ("minutes", "said"),
    [(30, "30 minutes"), (60, "1 hour"), (90, "1 hour 30 minutes"), (120, "2 hours")],
)
def test_a_length_is_said_the_way_a_person_would_say_it(minutes, said):
    assert agent_rules.describe_when(START, START + timedelta(minutes=minutes)).endswith(
        f"for {said}"
    )


def test_a_morning_time_is_not_said_with_a_leading_zero():
    nine = START.replace(hour=9, minute=5)

    assert "at 9:05 AM" in agent_rules.describe_when(nine, nine + timedelta(hours=1))
