"""Checking what the assistant said, and what it may remember.

Both are the server deciding something from text a model produced, so both get the forms
a model really produces: numbers as words, a claim id read in pairs, an address spelled
out. A check that only passed the tidy form would turn every voice approval into a
click, and one that passed too much would be no check.
"""

from __future__ import annotations

import pytest

from app.services.rules import agent_readback as readback
from app.services.rules.agent_readback import (
    amount_term,
    any_term,
    date_term,
    email_term,
    text_term,
    time_term,
)

# ── Numbers said as words ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("said", "numbers"),
    [
        ("forty-four seventy-one", ["44", "71"]),
        ("four four seven one", ["4", "4", "7", "1"]),
        ("one thousand two hundred thirty-four", ["1234"]),
        ("twelve hundred thirty four", ["1234"]),
        ("two thousand twenty six", ["2026"]),
        ("one hundred and five", ["105"]),
        ("the twenty first", ["the", "21"]),
        ("two oh five", ["2", "0", "5"]),
        ("nineteen ninety", ["19", "90"]),
        ("five and six", ["5", "and", "6"]),
    ],
)
def test_numbers_are_read_the_way_they_are_said(said, numbers):
    assert readback.tokens(said) == numbers


def test_written_numbers_lose_their_punctuation():
    assert readback.tokens("$1,234.50 at 2:30 p.m. on the 14th") == [
        "1234.50",
        "at",
        "2",
        "30",
        "pm",
        "on",
        "the",
        "14",
    ]


# ── Which record ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "said",
    [
        "the meeting Hendricks walkthrough",
        "the meeting Hendricks walk-through",
        "the meeting, hendricks  WALKTHROUGH, on Wednesday",
    ],
)
def test_a_name_is_heard_whatever_its_spacing_or_case(said):
    assert readback.heard(text_term("the title", "Hendricks walkthrough"), said)


def test_a_different_name_is_not():
    assert not readback.heard(text_term("the title", "Hendricks walkthrough"), "the Hendrix one")


@pytest.mark.parametrize(
    "said",
    ["claim CLM-4471", "claim C L M forty-four seventy-one", "claim CLM four four seven one"],
)
def test_a_claim_id_is_heard_however_its_digits_are_read(said):
    assert readback.heard(text_term("the claim", "CLM-4471"), said)


def test_a_claim_id_with_two_digits_swapped_is_not():
    assert not readback.heard(text_term("the claim", "CLM-4471"), "claim CLM forty-four seventeen")


def test_any_one_of_a_records_names_will_do():
    term = any_term("which supplement", ["Hendricks roof", "CLM-4471"])

    assert readback.heard(term, "the supplement with claim ID C L M forty-four seventy-one")
    assert readback.heard(term, "the Hendricks roof supplement")
    # The whole id, letters included: half of one identifies nothing.
    assert not readback.heard(term, "the supplement with claim ID forty-four seventy-one")
    assert not readback.heard(term, "the supplement")


# ── The total ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "said",
    [
        "the total is $1,234.50",
        "the total is 1234 dollars",
        "one thousand two hundred thirty-four dollars and fifty cents",
        "about twelve hundred thirty-four dollars",
    ],
)
def test_a_total_is_heard_as_digits_or_as_words(said):
    assert readback.heard(amount_term("the total", "1234.50"), said)


@pytest.mark.parametrize("said", ["the total is 234 dollars", "one thousand dollars", "a lot"])
def test_a_different_total_is_not(said):
    assert not readback.heard(amount_term("the total", "1234.50"), said)


# ── When ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "said",
    ["Wednesday, 14 October 2026", "October 14th", "the fourteenth of October", "Oct 14"],
)
def test_a_date_is_heard_in_either_order_and_as_an_ordinal(said):
    assert readback.heard(date_term("the date", month=10, day=14), said)


@pytest.mark.parametrize("said", ["October 15th", "the 14th", "November 14th", "Wednesday"])
def test_the_wrong_day_or_no_month_is_not_the_date(said):
    assert not readback.heard(date_term("the date", month=10, day=14), said)


@pytest.mark.parametrize(
    "said",
    ["at 2:30 PM", "at two thirty p.m.", "at two thirty in the afternoon", "at 14:30"],
)
def test_a_time_is_heard_on_either_clock(said):
    assert readback.heard(time_term("the time", hour=14, minute=30), said)


@pytest.mark.parametrize("said", ["at two thirty", "at 2:30 AM", "at 3:30 PM", "at 2:13 PM"])
def test_a_time_without_its_half_of_the_day_or_with_the_wrong_one_is_not(said):
    assert not readback.heard(time_term("the time", hour=14, minute=30), said)


def test_the_day_of_the_month_is_not_mistaken_for_an_hour():
    """A meeting on the 14th at 2 PM: "14" alone must not pass for 14:00."""
    term = time_term("the time", hour=14, minute=0)

    assert not readback.heard(term, "on October 14 for an hour")
    assert readback.heard(term, "on October 14 at two o'clock in the afternoon")
    assert readback.heard(term, "on October 14 at 2 PM")


@pytest.mark.parametrize(
    ("hour", "minute", "said"),
    [(9, 5, "nine oh five a.m."), (9, 0, "9 AM"), (12, 0, "noon"), (0, 0, "midnight")],
)
def test_awkward_times(hour, minute, said):
    assert readback.heard(time_term("the time", hour=hour, minute=minute), said)


def test_saying_i_am_is_not_saying_a_morning_time():
    assert not readback.heard(time_term("the time", hour=9, minute=0), "I am booking it for nine")


# ── An outside address ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "said",
    [
        "maria@acme.com",
        "maria at acme dot com",
        "m a r i a at acme dot com",
        "M-A-R-I-A at acme dot com.",
        "M, A, R, I, A, at acme dot com",
    ],
)
def test_an_address_is_heard_written_said_or_spelled(said):
    assert readback.heard(email_term("the address", "maria@acme.com"), said)


def test_an_address_with_a_letter_dropped_is_not_heard():
    """The miss the check exists to catch: seen once in testing against the real model."""
    assert not readback.heard(
        email_term("the address", "maria@acme.com"), "m a r i at acme dot com"
    )


def test_an_address_with_a_dash_and_a_digit_said_aloud():
    said = "j dash smith two at acme hyphen co dot com"

    assert readback.heard(email_term("the address", "j-smith2@acme-co.com"), said)


# ── Judging a whole read-back ─────────────────────────────────────────────────

TERMS = [
    text_term("the meeting's title", "Hendricks walkthrough"),
    date_term("the meeting's date", month=10, day=14),
    time_term("the meeting's time", hour=14, minute=30),
    email_term("an outside guest's address", "maria@acme.com"),
]
WHOLE = (
    "I am about to create the meeting Hendricks walkthrough on Wednesday the fourteenth of "
    "October at two thirty PM. An outside guest will be emailed: m a r i a at acme dot com."
)


def test_a_readback_with_everything_in_it_is_missing_nothing():
    assert readback.missing(TERMS, WHOLE) == []


def test_what_is_missing_is_named_by_kind_never_by_value():
    """It goes in a log, and a log must not hold what was said."""
    said = "I am about to create the meeting Hendricks walkthrough on October 14th."

    assert readback.missing(TERMS, said) == ["the meeting's time", "an outside guest's address"]


def test_a_turn_about_something_else_is_not_an_attempt_at_the_readback():
    assert not readback.is_an_attempt(TERMS, "One moment while I set that up.")
    assert readback.is_an_attempt(TERMS, "That is the Hendricks walkthrough.")


def test_a_proposal_with_nothing_that_must_be_heard_is_read_back_by_any_turn():
    assert readback.is_an_attempt([], "I am about to forget that.")
    assert readback.missing([], "I am about to forget that.") == []


def test_a_term_this_code_does_not_understand_is_never_vouched_for():
    assert readback.missing([{"what": "something new", "kind": "smell"}], WHOLE) == [
        "something new"
    ]


# ── What may be remembered ────────────────────────────────────────────────────

SAID = ["Please call me Sam.", "My meetings are usually forty five minutes.", "Invite Dana often."]


def test_a_memory_made_of_the_users_own_words_is_grounded():
    assert readback.ungrounded("Prefers to be called Sam", SAID) == []
    assert readback.ungrounded("Usual meeting length is 45 minutes", SAID) == []
    assert readback.ungrounded("Often invites Dana", SAID) == []


def test_an_address_the_user_never_said_is_not_grounded():
    """The poisoning case: an address planted in a record and read out by the assistant."""
    assert readback.ungrounded("Often invites x@example.com", SAID) == ["x@example.com"]


def test_a_genuine_quote_about_something_else_does_not_carry_a_planted_address():
    said = ["Remember that I like short answers."]

    assert readback.ungrounded("Likes short answers; send copies to x@example.com", said) == [
        "x@example.com"
    ]


def test_an_address_the_user_spelled_out_is_grounded():
    said = ["send them to m a r i a at acme dot com"]

    assert readback.ungrounded("Sends copies to maria@acme.com", said) == []


def test_a_number_the_user_never_said_is_not_grounded():
    assert readback.ungrounded("Usual meeting length is 90 minutes", SAID) == ["90"]


def test_a_name_the_user_never_said_is_not_grounded():
    assert readback.ungrounded("Often invites Dana and Priya", SAID) == ["priya"]


def test_a_name_on_the_roster_is_a_name_even_without_its_capital():
    roster = ["Maria Lopez"]

    assert readback.ungrounded("often invites maria", SAID, known_names=roster) == ["maria"]
    assert readback.ungrounded("often invites maria", ["invite maria"], known_names=roster) == []


def test_the_word_a_memory_opens_with_is_not_taken_for_a_name():
    assert readback.ungrounded("Prefers short answers. Usually books mornings.", ["x"]) == []


def test_a_name_at_the_start_of_a_memory_is_still_checked():
    assert readback.ungrounded("Priya is the usual PM", SAID) == ["priya"]


def test_a_plural_or_a_possessive_is_grounded_by_the_plain_word():
    said = ["I meet Dana on Friday"]

    assert readback.ungrounded("Meets Dana's team on Fridays", said) == []


def test_evidence_has_to_be_mostly_what_the_user_said():
    assert readback.evidence_is_the_users("please call me Sam", SAID)
    assert readback.evidence_is_the_users("call me sam, thanks", SAID)
    assert not readback.evidence_is_the_users("the gate code is 4471", SAID)
    assert not readback.evidence_is_the_users("", SAID)


@pytest.mark.parametrize(
    ("content", "why"),
    [
        ("The gate password is tulip", "secret"),
        ("API key for the portal is abc", "secret"),
        ("Drywall is $3 a square foot", "business_fact"),
        ("The usual rate for demo is forty", "business_fact"),
        ("Prefers short answers", None),
        ("Often invites Dana", None),
    ],
)
def test_secrets_and_prices_are_never_remembered(content, why):
    assert readback.forbidden_memory(content) == why
