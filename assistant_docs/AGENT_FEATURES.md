# BuildCo Assistant — Feature Candidates

**Status:** draft addendum. A list of candidates, not a plan. Nothing here is decided,
approved or being built.
**Written:** 2026-10-11.
**Baseline:** `AGENT_SPEC.md` as it stood on 2026-10-11 (1,986 lines, SHA-256
`0bac6c182782…928cfdf4`), and the assistant code on `feature/assistant-release-1` at
commit `2d8d876` plus its uncommitted work.

What BuildCo Assistant could do after Release 1 and Release 2: what is worth building
next, what should wait, and what should not be built.

> **Do not build from this document.** `AGENT_SPEC.md` is the contract for the build in
> progress. See `AGENT_GUIDE.md` section 2 for how the three addenda fit together and how
> a V2 is made.

**This document is shallower than the other two on purpose.** `AGENT_GUIDE.md` and
`AGENT_DESIGN.md` are written to be built from. Each candidate here is described far
enough to choose between them, and no further. A chosen candidate gets its own round of
questions and its own section before anyone builds it (section 9).

---

## 1. Summary

| | |
|---|---|
| **Candidates** | 12 recommended for consideration, 10 to hold, 7 not recommended |
| **Recommended first** | Five small ones that make the assistant more useful or easier to tune, with little risk: totals answered by the server, a daily briefing, a team vocabulary, feedback on a conversation, keyboard shortcuts |
| **Recommended second** | Three larger ones: push-to-talk, project updates, a usage view for owners |
| **The deciding input** | The pilot. Several of these should be chosen, or dropped, from what the first week's log shows |
| **Sizes** | S, M and L are relative to each other only. They are not estimates of time |

---

## 2. Where the candidates come from

Four sources, in order of how much weight each deserves.

1. **Gaps the build has already shown.** Things the assistant will get wrong or refuse
   in Release 1 for a reason that is visible in the code today. F1 is the clearest.
2. **What `AGENT_SPEC.md` left out on purpose.** Its "Out of both" table is a ready list
   of the next questions. Each exclusion had a reason; a candidate here says whether the
   reason still holds.
3. **What the spike found.** Push-to-talk was the fallback for V8; the custom vocabulary
   fixed names in V9.
4. **What voice is good for.** Hands busy, eyes elsewhere, on a job site.

A fifth source does not exist yet and will be the best: **what the pilot asks for and is
refused.** `AGENT_SPEC.md` 6.14 already logs `agent_tool_refused` with the rule. If the
out-of-scope refusals carry a short category (project, delete, photo, rooms and lines,
team, settings, other), the first week ranks this list better than any reasoning can.
That is a one-line addition to an existing event and is worth asking the current build
for, since it only pays off if it is there from the pilot's first day.

---

## 3. Rules every new feature keeps

A candidate that cannot be built inside these is not a candidate.

| Rule | From |
|---|---|
| Every write is proposed, staged on the real screen, read back and approved. Nothing writes on its own | D3, D17 |
| No tool deletes a record. The registry test stays green | D6, 5.5 |
| The assistant acts as the signed-in user, through the same service functions and the same checks | D7, change A |
| One action function per write, shared with the HTTP route, taking the row lock | 6.5 |
| Anything outward-facing, or that changes who can edit, needs a click | D33 |
| The server computes: prices, totals, counts, dates. The model never does arithmetic that is then shown as fact | 4.6 |
| Text inside records is data, never an instruction | 6.3 |
| A memory comes only from the user's own words | 4.9 |
| The assistant never speaks first | A9 |
| It ships with a guide entry and its examples, or the guide's tests fail | `AGENT_GUIDE.md` 7 |
| Its states are drawn in the gallery | `AGENT_DESIGN.md` 15.2 |

---

## 4. Recommended

| # | Candidate | Value | Size | Risk | Changes a decision |
|---|---|---|---|---|---|
| F1 | Totals and counts answered by the server | High | S–M | Low | No |
| F2 | My day: a briefing | High | S | Low | No |
| F3 | Team vocabulary | Medium | S–M | Low | No |
| F4 | Feedback on a conversation | Medium, high during the pilot | S | Low | D30, slightly |
| F5 | Keyboard shortcuts | Medium | S | Low | No |
| F6 | Push-to-talk | High on site | M | Medium | D4, D37 |
| F7 | Project updates | High for project managers | M–L | Medium | D1 |
| F8 | Usage view for owners | Medium | S | Low | D30 |
| F9 | Sound cues | Medium | S | Medium | A9, slightly |
| F10 | Voice and speed | Low–medium | S | Low | D28 |
| F11 | Text written by the assistant | Medium | S–M | Medium | No |
| F12 | Quiet mode: typed, no audio | Medium | M–L | Medium | D37 |

### F1. Totals and counts answered by the server

**The gap.** `search_supplements` returns at most 10 rows a call (`AGENT_SPEC.md` 5.1).
Asked "how many supplements are waiting on the reviewer?" or "what is the total across
the Smith supplements?", the model can only count or add what it was handed. With more
than ten matches the answer is wrong, and it will be said with confidence. This is the
one candidate that fixes something Release 1 will get wrong.

**What it does.** A read tool, `summarise_supplements`, takes the same filters as the
search and returns counts and sums computed in the database: how many, the total, and
optionally a breakdown by status, carrier, project manager or month. A matching
`summarise_meetings` for "how many meetings do I have this week".

- Limited to what the user may see, by the same rule as the search.
- The answer is spoken as a figure and shown as a small table in the panel, with a link
  to the list filtered the same way, so the number can be checked.
- The instruction gains one line: for "how many" and "how much", use the summary tool;
  never count or add rows yourself.

**Needs.** Two read functions in the services. No tables, no approvals, no protocol
change.

**Open.** Which breakdowns matter. Ask the pilot what they ask.

### F2. My day: a briefing

**What it does.** "What's on today?" gets one composed answer: today's meetings, in
order; supplements the reviewer sent back with changes requested; supplements still
waiting on the reviewer, with how long; and anything locked that is the user's.

- One read tool, `get_my_day`, so the answer is one call and one consistent snapshot
  instead of four searches stitched together by the model.
- Spoken as three or four sentences. Shown as a card with a section for each, each row
  a link.
- Offered as the first example on the idle panel in the morning (`AGENT_GUIDE.md` 5.1).
- It answers when asked. It does not start itself: A9 stands.

**Needs.** One read function. No tables.

**Open.** What "today" should contain for each role. A project manager and an estimator
want different things.

### F3. Team vocabulary

**The evidence.** The spike gave input transcription a vocabulary of catalogue names,
units and roster names, and it fixed both roster names it was tried on, which were wrong
every time without it (`AGENT_SPEC.md` 6.3, V9). The same will be true of names that are
in nobody's roster: carriers, adjusters, clients, streets, product names.

**What it does.** A list in Settings, **Words the assistant should know**, that owners
and admins edit. It is added to the vocabulary that 6.3 already builds.

- A cap on the number of entries and on their length, set by what the Live API accepts.
  That limit has to be looked up before this is specified.
- Carrier and client names already in the data could be added automatically. Whether to
  do that, and how many, is a design question: a long vocabulary may help less than a
  short one.

**Needs.** One column or small table on team settings; a Settings field; the vocabulary
builder reads it.

**Why this is not team-shared memory.** D13 keeps memory personal. This is a spelling
list, entered deliberately by an admin, with no facts about anyone in it.

### F4. Feedback on a conversation

**What it does.** When a conversation ends, the closing card asks **How did that go?**
with a thumbs up and a thumbs down. A thumbs down opens an optional one-line note.

- Stored on the conversation.
- **Who can see it is the whole question.** D30 says nobody but the user sees their
  conversations. A rating nobody else can read is useless. The proposal: the rating and
  the note are visible to owners, and the transcript is not, unless the user ticks
  "include this conversation" when they send it. That is a small, explicit, per-case
  exception to D30, made by the person whose conversation it is.
- A log event with the rating and no text, so it can be read beside the signals in 6.14.

**Why now.** It is cheap, and the pilot is when it is worth most. A thumbs down beside a
high `agent_readback_unverified` count says something neither says alone.

**Needs.** Two columns on `agent_conversations`; one endpoint; a small owner-only list.

### F5. Keyboard shortcuts

**What it does.** Open and close the panel; mute and unmute; move focus to the text
box. Esc for Stop and Enter to send already exist.

- The keys are not chosen here. The obvious ones collide with browsers: Ctrl+J opens
  downloads in Chrome, and Ctrl+K belongs to the browser's own search. They are picked by
  testing in Chrome, Edge and Safari, and listed in the guide's *Keyboard* topic.
- None of them approves anything. An approval is a deliberate click or a spoken yes.
- Closing the panel ends the conversation (D25), so the close shortcut asks first when a
  conversation is live.

**Needs.** Frontend only.

### F6. Push-to-talk

**Why.** An open microphone on a job site hears the job site. Push-to-talk was the
spike's fallback for echo on real speakers (V8), and iPad Safari is still untested. It
is also what people expect in a shared office.

**What it does.** A setting in the panel, remembered per browser: **Open microphone**
(as now) or **Hold to talk**. In hold mode the microphone sends audio only while a key
or the on-screen button is held.

- **Approval gets simpler, not harder.** The timing rule in 4.4 asks whether the
  approving utterance began after the read-back finished. In hold mode, "began" is the
  moment the key went down, which the browser knows exactly.
- **The allowance needs a decision.** D37 meters live time because an open microphone
  streams and bills continuously. In hold mode nothing is streamed between presses. The
  honest options: meter only held time plus the assistant's speech, which makes the
  allowance last much longer in this mode; or keep metering the whole conversation, which
  is simpler and the same for everyone. This changes what D37 means and is the user's to
  decide.
- Interruption still works: pressing the key while the assistant speaks stops it.

**Needs.** The audio capture module; the `audio` frame or a new one, to tell the server
the microphone is gated; the metering rule; a protocol field for "utterance began".

**Risk.** Medium. It touches the voice path the spike validated only in open mode, and
needs its own listening test.

### F7. Project updates

**What it lifts.** D1 made projects read-only. A project manager on site will ask for
exactly what is excluded: "mark demo complete on the Smith job", "put the Garcia project
on hold".

**What it does, and what it does not.**

| In | Out |
|---|---|
| Change a project's work status | Create a project |
| Mark a milestone done, or not done | Add, rename or remove milestones |
| | Closing forms, which are signed documents |
| | Linking and unlinking supplements |
| | Cancelling or closing a project |

Two write tools, `propose_project_status` and `propose_milestone`, each staged on the
real project page and approved like any other change.

**Needs.** An action function per write (6.5) with its row lock; the project access rule
that change A moved into the services; staged presentation on the project page; whether
a status change notifies anyone, which decides voice or click; the project activity feed
recording that the change came through the assistant.

**Risk.** Medium. It is a new screen to stage on and a second record type with its own
permission rule. It should follow the pattern of the supplement transition exactly.

**Open.** Which statuses each role may set, and whether any of them sends anything
outward. Both have to be read from the project code before this is specified.

### F8. Usage view for owners

**What it does.** A table in Settings, beside the allowance field: per person, minutes
used today and over the last 30 days, the number of conversations, and the number of
changes saved. No transcripts, no summaries, no content of any kind.

**Why.** The allowance is one number for the whole team, set by an owner who today has
nothing to set it from. 6.14 names "minutes used per person" as a signal to watch and
offers only the log to read it in.

**The decision it touches.** D30 says there is no team-wide view. This shows how much,
never what. It is still a change to what an owner can see about a colleague, and needs a
plain yes.

**Needs.** One read endpoint over data that already exists. No tables.

### F9. Sound cues

**What it does.** Three short, quiet sounds: the microphone opened, the microphone
paused, a change was saved. For someone looking at the form and not the panel, or at
neither.

**Why it is not just design.** A sound played by the browser is picked up by an open
microphone. The echo canceller is tuned for the assistant's voice, and a cue that leaks
could look like the start of a user utterance to the timing guard in 4.4. So each cue
has to be tested against that guard, and "saved" must not be played while the answer
window is open.

**Needs.** Frontend audio; a setting to turn them off; a listening test. A9 says nothing
plays on its own: these play only as the direct result of something the user did or
approved.

### F10. Voice and speed

**What it does.** A choice of two or three voices and a speaking rate, in Profile.
D28 chose one voice to keep the build small.

**Needs.** A per-user preference passed into the run configuration; a check that every
offered voice passes the read-back verifier (D43) as well as the chosen one does, since
that depends on how clearly amounts and spelled addresses are transcribed.

### F11. Text written by the assistant

**What it does.** The assistant drafts the free text that some forms ask for: the note
that goes to the reviewer with Submit for Review, a meeting's description. "Send this
for review and tell them the flooring quantities changed after the re-measure."

- The drafted text is shown in full on the staged form and on the approval card.
- It is an exception in the read-back: "the note was written by the assistant". It is
  read back in full if short, summarised with the full text on screen if long.
- Submit for Review is already click-only, so the outward path keeps its click.

**Risk.** Medium. This is the first time words composed by the model, not chosen from
the data or said by the user, would leave the building under the user's name. The
approval has to make that unmistakable.

### F12. Quiet mode: typed, no audio

**What it does.** A conversation with no microphone and no spoken replies: typed in,
text out. For an open office, and for people who would rather not talk to a computer.

**Why it is not small.** A typed message today still goes into the live audio session
and is answered aloud (V5, D31). A true text mode is a different, cheaper model path
with no audio at all. The proposal engine does not care which model proposed, and every
approval would be a click, so the safety story holds. But it is a second runtime to
build and test.

**The decision it touches.** D37 says there is no text-only fallback once the allowance
is spent. If quiet mode costs a fraction of voice, the pressure to let it continue past
the allowance will be immediate. Decide that before building it.

---

## 5. Recommended order

**First, together, straight after Release 1 is open to everyone:** F1, F2, F3, F4, F5.
All small, all low risk, none changes a safety rule, and F4 is worth most while the team
is still new to the assistant. F1 comes first within the batch: it corrects answers that
are otherwise wrong.

**Second, after the pilot's data is read:** F6, F7, F8. Each changes a recorded decision
and each should be confirmed by what people actually did. F6 moves up if iPad Safari
fails the listening test at `1-Human`, because then it is not a feature but the fix.

**When there is appetite:** F9, F10, F11, F12.

Nothing here should be built before Release 2. Editing rooms and lines by voice is the
feature the whole specification was shaped around, and it is worth more than everything
in this document.

---

## 6. Hold for later

Worth doing. Not yet, for the reason given.

| Candidate | What it is | Why wait |
|---|---|---|
| Phone layout | The assistant on a phone, where hands-busy voice is most useful | D26. Work mode shows the change on the real screen beside the panel, and a phone has no beside. It needs a different approval design, not a narrower one. L |
| Spanish | Conversations in Spanish | D24. The read-back verifier (D43), the instruction and the guide are all written for English. Each has to be redone and re-measured. L |
| Photos by voice | "Attach the photo I just took to the kitchen baseboard line" | Possible in principle once change C has given lines stable ids. Needs the camera or file picker opened from the panel and a way to stage an upload. L |
| Undo the last change | "Undo that" after a save | Only an edit can be undone, by proposing the old values again. A created record cannot, because that is a delete (D6). A feature that works half the time needs careful wording. M |
| Find a time | "When are Maria and I both free on Thursday?" | Members see only their own and invited meetings. Showing when a colleague is busy, without showing what they are doing, needs a new rule. M |
| Changes to several records at once | "Archive every supplement approved before June" | D10 already lets one approval cover one request. The read-back for forty records, and a cap on how many, need designing. M–L |
| Resuming a conversation | Carry on yesterday's | D20. The spike showed the model forgets early turns even inside one session (V4). Memory already carries what matters across days |
| Reports and exports by voice | "Email me the PDF" | The PDF appears to be made in the browser (`jspdf` is a frontend dependency), so the server has nothing to email. "Open the report" by `show_in_app` may be all that is needed, and is nearly free |
| Marked as made with the assistant | A note on a record's history that a change came through the assistant | Projects have an activity feed. Supplements and meetings do not appear to have one to write to. Comes with F7 for projects |
| A resizable panel | Drag the panel wider | `AGENT_DESIGN.md` fixes it at 400px. Wait to hear that it is too narrow |

---

## 7. Not recommended

| Candidate | Why not |
|---|---|
| Deleting, trashing, cancelling | D6, and the reason people can trust the rest. No tool exists, so the assistant cannot be talked into it. That property is worth more than the convenience |
| Team administration, settings and catalogue edits | Rare, high-stakes, and already quick by hand. A mis-heard role change is not worth saving a form |
| A wake word, or always listening | An open microphone bills continuously and streams the room to the cloud. On a job site that room has other people in it |
| The assistant starting conversations, reminders spoken aloud | A9. A reminder is a meeting with yourself, which already works |
| Skipping approval for "safe" changes | D3. The approval is how a mis-hearing is caught. If approvals turn out to be tedious, the pilot will show it in the log, and the answer is a faster approval, not none |
| A view of other people's transcripts | D30 |
| A simulated cursor, or the assistant visibly clicking through the app | D17. It looks impressive and adds waiting time without adding information |

---

## 8. Smaller things

Not features. Noted so they are not lost.

- A category on out-of-scope refusals in the log (section 2). Ask the current build.
- After a save, a suggested next step in the panel: after creating a supplement, "Open
  it to add rooms". A link, not speech.
- "Open the report", "open the review link", "open Settings" through `show_in_app`.
- The idle panel remembering the last few things the user asked and offering them again
  as examples.

---

## 9. Before a candidate is built

A chosen candidate becomes a section of the next specification. It is ready to build
when all of this can be written down:

| | |
|---|---|
| **What the user says and sees** | Two or three real exchanges, start to finish |
| **Tools** | Names, inputs, what each returns; read, write or control |
| **Approval** | Voice or click, and why. The exceptions the read-back must name |
| **Where it is staged** | The real screen and the real form |
| **Permissions** | Which service function enforces it, and the test that a member is refused |
| **Data** | New tables or columns, and their migration |
| **Decisions it changes** | Which of D1 to D43, and the new wording |
| **Failure** | What the user is told for each way it can go wrong |
| **Guide** | Its topic text and its examples (`AGENT_GUIDE.md`) |
| **Design** | Its states in the gallery (`AGENT_DESIGN.md`) |
| **Tests** | Including a scripted conversation |
| **Owner split** | Which steps are Claude's and which are a person's |

---

## 10. Delivery plan

### Ownership

| Phase | What | Owner |
|---|---|---|
| F0-Human | Read this list. Strike what is not wanted. Add what is missing. Decide whether to ask the session building Release 1 for the refusal category on `agent_tool_refused` (section 2) | Human |
| F1-Human | Run the pilot. Read the refusals and the feedback | Human |
| F1-Claude | For each chosen candidate: a round of questions, then its section, to the standard of section 9 | Claude |
| F2-Human | Approve each section | Human |
| F2-Claude | Build the approved batch in one pass, uncommitted on its own branch | Claude |
| F3-Human | Walkthrough, review, commit, release | Human |

---

## 11. Open questions

| # | Question |
|---|---|
| FQ1 | Which of F1 to F12 are wanted at all. Everything after this depends on it |
| FQ2 | Is anything missing? This list was written from the code and the specification, not from the people who will use the assistant |
| FQ3 | F4 and F8 each let an owner see something about a colleague's use. Is either acceptable under D30? |
| FQ4 | F6: in hold-to-talk mode, is the allowance metered on held time or on the whole conversation? |
| FQ5 | F7: is the list of project changes in the right place, or is creating a project the thing people will ask for? |
| FQ6 | Should the first batch wait for Release 2, as recommended, or run beside it? |

---

## 12. Amendments to `AGENT_SPEC.md` for V2

None yet. A candidate amends the specification only once it has been chosen and written
up to the standard of section 9. Until then this document changes nothing.

The one exception is not a feature: the refusal category in section 2, which is a field
on an existing log event in 6.14.
