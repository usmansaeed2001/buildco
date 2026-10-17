"""BuildCo Assistant: the decisions the model is not trusted with.

Each of these is a small pure function, which is exactly why they get a full matrix: the
whole point of taking a decision away from the model is that it is then decided the same
way every time, and a gap here is a gap in the one place that was supposed to be solid.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
from decimal import Decimal
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
            replace(GOOD, readback_verified=False),
            replace(GOOD, phone=True),
        )
    }

    assert reasons == set(agent_rules.REFUSALS)


# ── On a phone, the user says the line back ───────────────────────────────────

MEETING_LINE = agent_rules.confirm_meeting(
    title="Hendricks walkthrough",
    start=datetime(2026, 10, 14, 14, 30, tzinfo=ZoneInfo("America/Los_Angeles")),
)
ON_A_PHONE = replace(GOOD, phone=True, confirm_terms=MEETING_LINE.terms)


def test_the_meeting_line_names_the_meeting_and_when_it_is():
    assert MEETING_LINE.line == "Hendricks walkthrough, Wednesday 14 October at 2:30 PM"


def test_on_a_phone_a_bare_yes_does_not_approve():
    facts = replace(ON_A_PHONE, said_since_readback="yes")

    assert agent_rules.refuse_voice_commit(facts) == "confirmation_missing"


@pytest.mark.parametrize(
    "said",
    [
        "Hendricks walkthrough, Wednesday 14 October at 2:30 PM",
        "yes, the hendricks walkthrough on the fourteenth of october at two thirty pm",
        "Yes. Hendricks walkthrough October 14th, 2:30 in the afternoon",
    ],
)
def test_on_a_phone_the_line_said_back_in_the_users_own_words_approves(said):
    facts = replace(ON_A_PHONE, said_since_readback=said)

    assert agent_rules.refuse_voice_commit(facts) is None


def test_on_a_phone_the_line_with_the_wrong_time_does_not_approve():
    facts = replace(ON_A_PHONE, said_since_readback="Hendricks walkthrough, 14 October at 3:30 PM")

    assert agent_rules.refuse_voice_commit(facts) == "confirmation_missing"


def test_on_a_phone_typing_the_line_approves_too():
    facts = replace(
        ON_A_PHONE,
        typed_after_readback=True,
        last_utterance_began_at=None,
        said_since_readback="hendricks walkthrough 14 october 2:30pm",
    )

    assert agent_rules.refuse_voice_commit(facts) is None


def test_on_a_phone_saying_the_line_before_the_readback_finished_still_does_not_count():
    facts = replace(
        ON_A_PHONE,
        last_utterance_began_at=39.0,
        said_since_readback=MEETING_LINE.line,
    )

    assert agent_rules.refuse_voice_commit(facts) == "answered_too_early"


def test_on_a_phone_a_proposal_with_no_line_needs_a_click():
    facts = replace(GOOD, phone=True, said_since_readback="yes")

    assert agent_rules.refuse_voice_commit(facts) == "confirmation_missing"


def test_away_from_a_phone_a_yes_is_still_enough():
    assert agent_rules.refuse_voice_commit(replace(GOOD, said_since_readback="yes")) is None


def test_the_supplement_line_needs_the_action_as_well_as_the_record():
    line = agent_rules.confirm_supplement(
        verb="Archive",
        keywords=["archive"],
        name="Hendricks roof, claim ID CLM-4471",
        record=agent_rules.supplement_terms(
            project_name="Hendricks roof", client_name="", identifier="CLM-4471"
        ),
    )
    facts = replace(GOOD, phone=True, confirm_terms=line.terms)

    assert line.line == "Archive Hendricks roof, claim ID CLM-4471"
    assert (
        agent_rules.refuse_voice_commit(replace(facts, said_since_readback="yes, hendricks roof"))
        == "confirmation_missing"
    )
    assert (
        agent_rules.refuse_voice_commit(
            replace(facts, said_since_readback="archive hendricks roof")
        )
        is None
    )


def test_the_add_lines_line_needs_the_new_total():
    line = agent_rules.confirm_add_lines(
        name="Hendricks roof",
        count=3,
        new_total=Decimal("5030.00"),
        record=agent_rules.supplement_terms(
            project_name="Hendricks roof", client_name="", identifier=""
        ),
    )
    facts = replace(GOOD, phone=True, confirm_terms=line.terms)

    assert line.line == "Add 3 lines to Hendricks roof, new total $5,030.00"
    assert (
        agent_rules.refuse_voice_commit(
            replace(facts, said_since_readback="add them to hendricks roof")
        )
        == "confirmation_missing"
    )
    assert (
        agent_rules.refuse_voice_commit(
            replace(facts, said_since_readback="add three lines to Hendricks roof, 5,030")
        )
        is None
    )


# ── Adding lines ──────────────────────────────────────────────────────────────


def test_adding_lines_may_be_approved_by_voice():
    assert (
        agent_rules.approval_policy(agent_rules.SUPPLEMENT_ADD_LINES)
        is AgentApprovalPolicy.VOICE_OR_CLICK
    )


def test_the_add_lines_readback_names_every_price_not_from_the_catalogue():
    lines = [
        agent_rules.AddedLine("Kitchen", False, "Baseboard", Decimal("4.50"), "catalogue"),
        agent_rules.AddedLine("Kitchen", False, "Paint", Decimal("30"), "differs", Decimal("25")),
        agent_rules.AddedLine("Bath", True, "Grab bar", Decimal("35"), "stated"),
    ]

    summary = agent_rules.supplement_add_lines_summary(
        name="Hendricks roof", lines=lines, old_total=Decimal("100"), new_total=Decimal("300")
    )
    terms = agent_rules.add_lines_terms(record=[], lines=lines, new_total=Decimal("300"))

    assert summary.startswith(
        "I am about to add 3 lines to the supplement Hendricks roof: 2 to Kitchen and 1 to "
        "a new room, Bath. The total goes from $100.00 to $300.00."
    )
    assert "Paint is at $30.00, the price you gave; the catalogue has $25.00." in summary
    assert "Grab bar is at $35.00, the price you gave; it is not from the catalogue." in summary
    assert "Baseboard" not in summary
    assert [term["value"] for term in terms] == ["300", "30", "35"]


def test_a_readback_that_left_something_out_cannot_be_approved_by_voice():
    """However well timed the yes was."""
    unverified = replace(GOOD, readback_verified=False)

    assert agent_rules.refuse_voice_commit(unverified) == "readback_unverified"


def test_typing_does_not_get_round_an_unverified_readback_either():
    typed = replace(GOOD, readback_verified=False, typed_after_readback=True)

    assert agent_rules.refuse_voice_commit(typed) == "readback_unverified"


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


# ── Voice or a click, for every kind of change ────────────────────────────────

VOICE, CLICK = AgentApprovalPolicy.VOICE_OR_CLICK, AgentApprovalPolicy.CLICK


@pytest.mark.parametrize(
    ("kind", "extra", "policy"),
    [
        (agent_rules.MEETING_CREATE, {"emails_anyone": False}, VOICE),
        (agent_rules.MEETING_CREATE, {"emails_anyone": True}, CLICK),
        (agent_rules.MEETING_UPDATE, {"emails_anyone": False}, VOICE),
        (agent_rules.MEETING_UPDATE, {"emails_anyone": True}, CLICK),
        (agent_rules.SUPPLEMENT_CREATE, {}, VOICE),
        (agent_rules.SUPPLEMENT_UPDATE, {}, VOICE),
        (agent_rules.SUPPLEMENT_SUBMIT, {}, CLICK),
        (agent_rules.MEMORY_CHANGE, {}, VOICE),
        (agent_rules.SUPPLEMENT_TRANSITION, {"transition": "archive"}, VOICE),
        (agent_rules.SUPPLEMENT_TRANSITION, {"transition": "unarchive"}, VOICE),
        (agent_rules.SUPPLEMENT_TRANSITION, {"transition": "recall"}, VOICE),
        (agent_rules.SUPPLEMENT_TRANSITION, {"transition": "resubmit_ready"}, VOICE),
        (agent_rules.SUPPLEMENT_TRANSITION, {"transition": "lock"}, CLICK),
        (agent_rules.SUPPLEMENT_TRANSITION, {"transition": "unlock"}, CLICK),
        (agent_rules.SUPPLEMENT_TRANSITION, {"transition": "admin_approve"}, CLICK),
        (agent_rules.SUPPLEMENT_TRANSITION, {}, CLICK),
    ],
)
def test_what_may_be_approved_by_voice(kind, extra, policy):
    assert agent_rules.approval_policy(kind, **extra) is policy


def test_a_kind_of_change_nobody_has_thought_about_needs_a_click():
    """The cautious answer is the default, so a new kind cannot be voice-approved by accident."""
    assert agent_rules.approval_policy("supplement.delete") is CLICK
    assert agent_rules.approval_policy("") is CLICK


def test_every_status_change_has_words_for_it_and_none_is_a_delete():
    from app.services.rules.estimate_rules import TRANSITIONS

    assert set(agent_rules.TRANSITION_WORDS) == set(TRANSITIONS)
    assert set(TRANSITIONS) >= agent_rules.CLICK_ONLY_TRANSITIONS
    assert not [kind for kind in agent_rules.KINDS if "delete" in kind or "trash" in kind]


# ── More read-backs ───────────────────────────────────────────────────────────


def test_a_supplement_is_named_by_project_and_claim_id():
    name = agent_rules.supplement_name

    assert name(project_name="Hendricks roof", client_name="Acme", identifier="CLM-1") == (
        "Hendricks roof, claim ID CLM-1"
    )
    assert name(project_name="", client_name="Acme", identifier="CLM-1") == "Acme, claim ID CLM-1"
    assert name(project_name="", client_name="", identifier="CLM-1") == "claim ID CLM-1"
    assert name(project_name="", client_name="", identifier="") == "the unnamed supplement"


def test_money_is_said_with_its_thousands_and_cents():
    assert agent_rules.money("1234.5") == "$1,234.50"
    assert agent_rules.money(0) == "$0.00"


def test_a_status_change_reads_back_the_record_its_status_and_its_total():
    from decimal import Decimal

    said = agent_rules.supplement_transition_summary(
        name="Hendricks roof, claim ID CLM-1",
        action="recall",
        status="submitted",
        total=Decimal("1234.50"),
    )

    assert said == (
        "I am about to recall from review the supplement Hendricks roof, claim ID CLM-1, "
        "which is currently submitted. Its total is $1,234.50. The reviewer's link will "
        "stop working."
    )


def test_a_total_of_nothing_is_not_read_out_or_required():
    from decimal import Decimal

    said = agent_rules.supplement_transition_summary(
        name="Hendricks roof", action="archive", status="active", total=Decimal("0")
    )
    terms = agent_rules.supplement_terms(
        project_name="Hendricks roof", client_name="", identifier="", total=Decimal("0")
    )

    assert "total" not in said
    assert [term["what"] for term in terms] == ["which supplement"]


def test_changing_a_meeting_always_says_when_it_will_be_and_whether_anyone_is_emailed():
    quiet = agent_rules.meeting_update_summary(
        title="Hendricks walkthrough",
        start=START,
        end=START + timedelta(minutes=45),
        changes=["The description changes."],
        invitees=[Invitee(label="Sam Second")],
        reinvites=False,
    )
    loud = agent_rules.meeting_update_summary(
        title="Hendricks walkthrough",
        start=START,
        end=START + timedelta(minutes=45),
        changes=["The time changes."],
        invitees=[Invitee(label="Sam Second")],
        reinvites=True,
        dropped=["Rita Removed"],
    )

    assert "It will be on Wednesday, 14 October 2026 at 2:30 PM, for 45 minutes." in quiet
    assert quiet.endswith("No email will be sent.")
    assert "Sam Second will be emailed an updated invite." in loud
    assert "Rita Removed has been removed from the team and will come off this meeting." in loud


def test_what_must_be_heard_for_a_meeting_is_its_name_its_time_and_any_outside_address():
    terms = agent_rules.meeting_terms(
        title="Hendricks walkthrough",
        start=START,
        invitees=[Invitee(label="Sam"), Invitee(label="m@x.io", outside_email="m@x.io")],
        remembered=["length"],
    )

    assert [term["what"] for term in terms] == [
        "the meeting's title",
        "the meeting's date",
        "the meeting's time",
        "an outside guest's address",
        "that a value came from memory",
    ]


def test_forgetting_and_changing_a_memory_read_differently():
    assert agent_rules.memory_change_summary(old="Call me Sam", new=None) == (
        "I am about to forget this: Call me Sam"
    )
    assert "from: Call me Sam To: Call me Samuel" in agent_rules.memory_change_summary(
        old="Call me Sam", new="Call me Samuel"
    )


# ── The daily allowance ───────────────────────────────────────────────────────


def test_the_day_starts_at_midnight_utc_wherever_the_clock_was_read():
    from datetime import UTC

    in_la = datetime(2026, 10, 11, 17, 30, tzinfo=PACIFIC)  # 00:30 UTC on the 12th

    assert agent_rules.day_start(in_la) == datetime(2026, 10, 12, 0, 0, tzinfo=UTC)
    assert agent_rules.next_reset(in_la) == datetime(2026, 10, 13, 0, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("team", "default", "seconds"),
    [(None, 10, 600), (25, 10, 1500), (0, 10, 0), (-5, 10, 0)],
)
def test_the_teams_own_figure_wins_and_zero_is_a_figure(team, default, seconds):
    """Zero is the off switch. Only "never set" falls back to the default."""
    assert agent_rules.daily_limit_seconds(team, default) == seconds


@pytest.mark.parametrize(
    ("limit", "used", "left"), [(600, 0, 600), (600, 599, 1), (600, 600, 0), (600, 900, 0)]
)
def test_what_is_left_never_goes_below_nothing(limit, used, left):
    assert agent_rules.remaining_seconds(limit, used) == left


# ── Silence ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("quiet_for", "state"),
    [(0, "ok"), (89.9, "ok"), (90, "warn"), (119.9, "warn"), (120, "end"), (500, "end")],
)
def test_silence_warns_at_ninety_seconds_and_ends_at_two_minutes(quiet_for, state):
    assert (
        agent_rules.idle_state(
            quiet_for=quiet_for, warning_after=90, timeout_after=120, paused=False
        )
        == state
    )


def test_a_paused_conversation_is_never_idle():
    assert (
        agent_rules.idle_state(quiet_for=10_000, warning_after=90, timeout_after=120, paused=True)
        == "ok"
    )
