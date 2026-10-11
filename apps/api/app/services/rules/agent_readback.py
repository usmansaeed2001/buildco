"""Checking what the assistant actually said.

The server writes the read-back and gives it to the model to speak. A voice model
paraphrases, so the server cannot make it say those words and does not pretend to.
What it can do is read the transcript of the model's own speech afterwards and look for
the things that must have been heard: which record, the total, a meeting's date and
time, and every exception. If any is missing, that proposal can only be approved by
click.

This is a check on what was said, so it does not depend on the model obeying. Its limit
is known: the transcript follows the text the model meant to say very closely, so it is
evidence of what was said, not an independent recording of it.

**The normaliser has to accept what a model really produces**: amounts as digits or as
words, a claim id read in pairs ("forty-four seventy-one"), a time as "2:30 PM" or "two
thirty in the afternoon", and an address written out, said with "at" and "dot", or
spelled letter by letter.

Pure functions over text. A term is plain data, because it is stored with the proposal.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

Term = Mapping[str, Any]

# ── Numbers said as words ─────────────────────────────────────────────────────

_UNITS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
}
_TEENS = {
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
}
_TENS = {
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
}
_SCALES = {"thousand": 1_000, "million": 1_000_000}
_ZEROES = {"zero", "oh"}
#: "The fourteenth" is how a date is said. Only up to the thirty-first: nothing else is.
_ORDINALS = {
    "first": 1,
    "second": 2,
    "third": 3,
    "fourth": 4,
    "fifth": 5,
    "sixth": 6,
    "seventh": 7,
    "eighth": 8,
    "ninth": 9,
    "tenth": 10,
    "eleventh": 11,
    "twelfth": 12,
    "thirteenth": 13,
    "fourteenth": 14,
    "fifteenth": 15,
    "sixteenth": 16,
    "seventeenth": 17,
    "eighteenth": 18,
    "nineteenth": 19,
    "twentieth": 20,
    "thirtieth": 30,
}
_NUMBER_WORDS = (
    set(_UNITS) | set(_TEENS) | set(_TENS) | set(_SCALES) | _ZEROES | set(_ORDINALS) | {"hundred"}
)


def _numbers(words: Sequence[str]) -> list[int]:
    """The numbers in a run of number words, as a person would read them.

    A new number starts wherever the grammar cannot continue the last one. That is what
    makes "forty-four seventy-one" the two numbers 44 and 71, which side by side spell
    the claim id 4471, and "four four seven one" the four digits of the same id.
    """
    found: list[int] = []
    total = 0
    current: int | None = None
    last = ""

    def flush() -> None:
        nonlocal total, current, last
        if current is not None or last == "scale":
            found.append(total + (current or 0))
        total, current, last = 0, None, ""

    for word in words:
        if word in _ZEROES:
            flush()
            found.append(0)
        elif word in _UNITS or (word in _ORDINALS and _ORDINALS[word] < 10):
            value = _UNITS.get(word) or _ORDINALS[word]
            if current is not None and last in ("tens", "hundred"):
                current += value
            elif current is None and last == "scale":
                current = value
            else:
                flush()
                current = value
            last = "unit"
        elif word in _TEENS or word in _TENS or word in _ORDINALS:
            value = _TEENS.get(word) or _TENS.get(word) or _ORDINALS[word]
            kind = "tens" if word in _TENS or value in (20, 30) else "teen"
            if current is not None and last == "hundred":
                current += value
            elif current is None and last == "scale":
                current = value
            else:
                flush()
                current = value
            last = kind
        elif word == "hundred":
            if current is not None and last in ("unit", "teen", "tens") and current < 100:
                current *= 100
            else:
                flush()
                current = 100
            last = "hundred"
        else:
            total += (current if current is not None else 1) * _SCALES[word]
            current = None
            last = "scale"
    flush()
    return found


_TOKEN = re.compile(r"[a-z]+|\d+(?:[.,]\d+)*")


def tokens(text: str) -> list[str]:
    """Text as comparable tokens: lower case, numbers as digits however they were said.

    ``$1,234.50`` becomes ``1234.50``; ``2:30`` becomes ``2`` and ``30``; ``14th``
    becomes ``14``; ``p.m.`` becomes ``pm``; a run of number words becomes its numbers.
    """
    lowered = text.lower().replace("\u2019", "'")
    lowered = re.sub(r"\b([ap])\.\s?m\b\.?", r"\1m", lowered)
    lowered = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", lowered)
    lowered = re.sub(r"(\d):(\d)", r"\1 \2", lowered)

    raw = _TOKEN.findall(lowered)
    out: list[str] = []
    run: list[str] = []

    def end_run() -> None:
        if run:
            out.extend(str(number) for number in _numbers(run))
            run.clear()

    for index, token in enumerate(raw):
        if token in _NUMBER_WORDS:
            run.append(token)
            continue
        # "One hundred and five" is one number; "five and six" is two.
        if (
            token == "and"
            and run
            and run[-1] in ("hundred", *_SCALES)
            and index + 1 < len(raw)
            and raw[index + 1] in _NUMBER_WORDS
        ):
            continue
        end_run()
        if token[0].isdigit():
            # A thousands separator goes; a decimal point stays.
            token = re.sub(r",(?=\d{3}\b)", "", token).replace(",", ".")
        out.append(token)
    end_run()
    return out


def squash(text: str) -> str:
    """Letters and digits only, with numbers normalised. For "does it contain this"."""
    return "".join(re.sub(r"[^a-z0-9]", "", token) for token in tokens(text))


def _as_int(token: str) -> int | None:
    whole = token.split(".", 1)[0]
    return int(whole) if whole.isdigit() else None


# ── One kind of term at a time ────────────────────────────────────────────────


def _text_heard(value: str, said: str) -> bool:
    wanted = squash(value)
    return bool(wanted) and wanted in squash(said)


def _amount_heard(value: str, said: str) -> bool:
    """The whole-dollar part of an amount, as a number of its own.

    Cents are not required. People are read totals without them, and the full amount is
    on the card. A whole number, not a substring: 234 does not vouch for 1,234.
    """
    dollars = _as_int(value.replace(",", ""))
    return dollars is not None and any(_as_int(token) == dollars for token in tokens(said))


_MONTHS = (
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
)


def _date_heard(month: int, day: int, said: str) -> bool:
    """The month by name and the day beside it: "October 14th", "the 14th of October"."""
    name = _MONTHS[month - 1]
    spellings = {name, name[:3], "sept"} if month == 9 else {name, name[:3]}
    heard = tokens(said)
    for index, token in enumerate(heard):
        if token not in spellings:
            continue
        nearby = heard[max(0, index - 3) : index + 4]
        if any(_as_int(other) == day for other in nearby if "." not in other):
            return True
    return False


_PM = {"pm", "afternoon", "evening", "tonight", "night"}
_AM = {"am", "morning"}


def _time_heard(hour: int, minute: int, said: str) -> bool:
    """A clock time, on either clock, with its half of the day.

    "2:30 PM", "two thirty in the afternoon" and "14:30" all pass for 14:30. "Two
    thirty" alone does not: which half of the day is the part that gets misheard.
    """
    heard = tokens(said)
    if minute == 0 and ((hour == 12 and "noon" in heard) or (hour == 0 and "midnight" in heard)):
        return True

    twelve = hour % 12 or 12
    meridiem = _PM if hour >= 12 else _AM
    for index, token in enumerate(heard):
        value = _as_int(token)
        if value is None or "." in token:
            continue
        rest = heard[index + 1 :]
        on_the_hour_in_digits = False
        if minute:
            if rest[:1] == ["0"] and minute < 10:
                rest = rest[1:]
            if not rest or _as_int(rest[0]) != minute:
                continue
            rest = rest[1:]
        else:
            on_the_hour_in_digits = rest[:1] in (["00"], ["0"])
            while rest and rest[0] in ("00", "0", "o", "clock", "oclock"):
                rest = rest[1:]
        # A bare "14" is as likely to be the day of the month as two in the afternoon.
        if value == hour and hour >= 13 and (minute or on_the_hour_in_digits):
            return True
        if value == twelve and meridiem & set(rest[:4]):
            return True
    return False


_SPELLED_HYPHEN = re.compile(r"\b([a-z0-9])-(?=[a-z0-9]\b)")


def _address_forms(said: str) -> list[str]:
    """What was said, read as an email address might have been said.

    "maria at acme dot com", "m a r i a at acme dot com" and "M-A-R-I-A@acme.com" all
    reduce to something containing ``maria@acme.com``.
    """
    lowered = said.lower()
    forms = []
    for with_numbers in (False, True):
        text = lowered
        if with_numbers:
            text = re.sub(
                r"\b(" + "|".join(sorted(_NUMBER_WORDS - {"oh", "second"})) + r")\b",
                lambda found: "".join(str(n) for n in _numbers([found.group(1)])),
                text,
            )
        text = _SPELLED_HYPHEN.sub(r"\1", text)
        text = re.sub(r"\bat (sign|symbol)\b|\bat\b", "@", text)
        text = re.sub(r"\b(dot|period|point)\b", ".", text)
        text = re.sub(r"\b(dash|hyphen|minus)\b", "-", text)
        text = re.sub(r"\bunderscore\b", "_", text)
        forms.append(re.sub(r"[^a-z0-9@._-]", "", text))
    return forms


def _email_heard(address: str, said: str) -> bool:
    wanted = address.strip().lower()
    return bool(wanted) and any(wanted in form for form in _address_forms(said))


def heard(term: Term, said: str) -> bool:
    """Whether one required term can be found in what the assistant said."""
    kind = term.get("kind")
    if kind == "text":
        return _text_heard(str(term["value"]), said)
    if kind == "any":
        return any(_text_heard(str(option), said) for option in term["values"])
    if kind == "amount":
        return _amount_heard(str(term["value"]), said)
    if kind == "date":
        return _date_heard(int(term["month"]), int(term["day"]), said)
    if kind == "time":
        return _time_heard(int(term["hour"]), int(term["minute"]), said)
    if kind == "email":
        return _email_heard(str(term["value"]), said)
    # A term this code does not understand cannot be vouched for.
    return False


def missing(terms: Sequence[Term], said: str) -> list[str]:
    """What should have been heard and was not, by each term's description.

    The description says what kind of thing it is ("the outside guest's address") and
    never the value, so it can go in a log.
    """
    return [str(term.get("what", "?")) for term in terms if not heard(term, said)]


def is_an_attempt(terms: Sequence[Term], said: str) -> bool:
    """Whether this turn was the read-back at all, complete or not.

    A turn that mentions none of the terms is something else: "one moment", or an
    answer to a different question. It neither verifies the proposal nor counts
    against it.
    """
    return not terms or any(heard(term, said) for term in terms)


# ── Building terms ────────────────────────────────────────────────────────────


def text_term(what: str, value: str) -> dict[str, Any]:
    return {"what": what, "kind": "text", "value": value}


def any_term(what: str, values: Sequence[str]) -> dict[str, Any]:
    return {"what": what, "kind": "any", "values": list(values)}


def amount_term(what: str, value: object) -> dict[str, Any]:
    return {"what": what, "kind": "amount", "value": str(value)}


def date_term(what: str, *, month: int, day: int) -> dict[str, Any]:
    return {"what": what, "kind": "date", "month": month, "day": day}


def time_term(what: str, *, hour: int, minute: int) -> dict[str, Any]:
    return {"what": what, "kind": "time", "hour": hour, "minute": minute}


def email_term(what: str, value: str) -> dict[str, Any]:
    return {"what": what, "kind": "email", "value": value}


# ── Memory grounding ──────────────────────────────────────────────────────────

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_CAPITALISED = re.compile(r"\b[A-Z][A-Za-z'\u2019-]*\b")
#: How a memory may begin without its first word being taken for somebody's name.
_OPENERS = frozenset(
    """a an the their my they user prefers prefer likes like dislikes wants want needs
    usually usual often commonly always never typically typical default calls call called
    named name names goes go reads read keeps keep works work uses use invites invite
    meetings meeting answers answer totals total short long is has does when for in on
    carrier carriers room rooms says say addressed address pm pms schedules schedule
    books book most generally i""".split()  # noqa: SIM905
)
#: Capitalised, and nobody's name.
_NOT_NAMES = frozenset({"i", "pm", "pms", "am", "ok", "buildco", "assistant"})
_SECRET = re.compile(
    r"\b(password|passcode|pass phrase|passphrase|pin|secret|api key|token|"
    r"social security|ssn|credit card|card number)\b",
    re.IGNORECASE,
)
_BUSINESS_FACT = re.compile(r"[$£€]\s?\d|\b(price|prices|priced|rate|rates|cost|costs)\b", re.I)


def forbidden_memory(content: str) -> str | None:
    """Why this must never be remembered, or ``None``.

    Secrets, and prices and rates: those are business facts that belong in the data,
    where they can be seen and corrected, not in what one person's assistant believes.
    """
    if _SECRET.search(content):
        return "secret"
    if _BUSINESS_FACT.search(content):
        return "business_fact"
    return None


def ungrounded(
    content: str, user_words: Sequence[str], *, known_names: Sequence[str] = ()
) -> list[str]:
    """The parts of a would-be memory the user never said, in this conversation.

    **Every email address, every number and every name** in it has to appear in the
    user's own words. A quote from the user that is real but about something else does
    not pass: the check is on the content. This is what stops text planted in a record,
    which an outsider can write through the public review page, from being read out by
    the assistant and then remembered as if the user had said it.

    ``known_names`` are names on the team's roster, so that a name written without its
    capital letter is still recognised as one.
    """
    spoken = " ".join(user_words)
    spoken_tokens = set(tokens(spoken))
    spoken_plain = {re.sub(r"[^a-z0-9]", "", word) for word in spoken.lower().split()}
    spoken_plain |= spoken_tokens
    problems: list[str] = []

    def said(plain: str) -> bool:
        # "Friday" is grounded by "Fridays", and the other way round.
        return bool({plain, f"{plain}s", plain.removesuffix("s")} & spoken_plain)

    addresses = _EMAIL.findall(content)
    for address in addresses:
        if not _email_heard(address, spoken):
            problems.append(address)
    remainder = _EMAIL.sub(" ", content)

    for token in tokens(remainder):
        if token[0].isdigit() and token not in spoken_tokens:
            whole = token.split(".", 1)[0]
            if whole not in {other.split(".", 1)[0] for other in spoken_tokens}:
                problems.append(token)

    roster = {part.lower() for name in known_names for part in name.split() if len(part) > 1}
    names: list[str] = []
    for found in _CAPITALISED.finditer(remainder):
        word = found.group(0)
        plain = re.sub(r"[^a-z0-9]", "", word.lower().removesuffix("'s").removesuffix("\u2019s"))
        if not plain or plain in _NUMBER_WORDS or plain in _NOT_NAMES:
            continue
        before = remainder[: found.start()].rstrip()
        opens_a_sentence = not before or before[-1] in ".!?:;"
        if opens_a_sentence and plain in _OPENERS and plain not in roster:
            continue
        names.append(plain)
    names.extend(
        plain
        for plain in (re.sub(r"[^a-z0-9]", "", word) for word in remainder.lower().split())
        if plain in roster
    )
    problems.extend(plain for plain in dict.fromkeys(names) if not said(plain))
    return problems


def evidence_is_the_users(evidence: str, user_words: Sequence[str]) -> bool:
    """Whether the words offered as evidence are, near enough, something the user said.

    Near enough, because the model quotes what it heard and the transcript is a separate
    transcription of the same audio: the two differ by a word here and there. Most of
    the evidence's words must be the user's. The content check above is the strict one.
    """
    wanted = [token for token in tokens(evidence) if len(token) > 2 or token.isdigit()]
    if not wanted:
        return False
    spoken = set(tokens(" ".join(user_words)))
    return sum(token in spoken for token in wanted) / len(wanted) >= 0.6
