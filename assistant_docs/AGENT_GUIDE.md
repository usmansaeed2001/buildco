# BuildCo Assistant — User Guide Specification

**Status:** draft, awaiting sign-off of its wording (phase G0-Human, section 12). It is
built after the design in `AGENT_DESIGN.md`, in that look.
**Written:** 2026-10-11. **Revised:** 2026-10-11, to follow the finished Release 1 and
revision 2 of the design.
**Baseline:** the assistant code on `feature/assistant-release-1` at commit `d9af970`
("Finish Release 1 of BuildCo Assistant"), and `AGENT_SPEC.md` as it stands beside this
file.

How people learn to use BuildCo Assistant: what they see the first time, where they look
when they are stuck, and how that help is kept true as the assistant changes.

> `AGENT_SPEC.md` is the main document. Where the two disagree on what the assistant
> does, `AGENT_SPEC.md` wins; this document wins on help content (section 2).

---

## 1. Summary

| | |
|---|---|
| **What** | Help for the assistant in five places, all drawn from one body of content |
| **Where** | In the panel first: examples when idle, a short introduction on first open, a help view, and one-line hints at the moment something new happens. Then a full page at `/help/assistant` |
| **Also** | The assistant answers "what can you do?" and "how do I approve?" from the same content, and can open the topic |
| **Kept true by** | The content lives in the API beside the tools. It is filtered by role and by what is switched on, and tests fail if a tool has no guide entry or the guide names something that does not exist |
| **Costs** | One read endpoint, one read tool, one control tool, one new `ui` action. No new tables |
| **Not included** | Video, a tour that drives the app, a practice sandbox, translation |

---

## 2. How this document relates to `AGENT_SPEC.md`

`AGENT_SPEC.md` is the main document: what the assistant does, how it is built, and the
status of each release. Three companion documents sit beside it, and it points to each:

| Document | Covers | Wins on | Ids |
|---|---|---|---|
| `AGENT_SPEC.md` | Behaviour, safety, architecture, releases | What the assistant does | D1…, A1…, Q1…, V1… |
| `AGENT_DESIGN.md` | How the assistant looks and moves | Appearance and motion | DS1…, DA1…, DQ1… |
| `AGENT_GUIDE.md` (this one) | Teaching people to use the assistant | Help content | G1…, GA1…, GQ1… |
| `AGENT_FEATURES.md` | What the assistant could do next | Nothing yet: candidates only | F1…, FQ1… |

Each companion uses its own id prefix, so nothing collides. Each ends with a table of the
sections of `AGENT_SPEC.md` it touches. **There is no V2 of the specification.** The
companions stay separate documents, and `AGENT_SPEC.md` carries a section that points to
them and the release each belongs to.

The design and the guide together are the **Experience release**: they change how
Release 1 looks and how people learn it, and nothing about what it can do. The design is
built first and the guide second, so the guide's components are made once, in the new
look.

Before building from this document, check it against the code as built, not as
specified: the amendments in section 15 name the sections to re-read.

---

## 3. Why the assistant needs a guide

Most of the assistant can be used by talking to it. A handful of its rules cannot be
guessed, and each of them looks like a fault to someone who has not been told:

| What happens | What a new user thinks |
|---|---|
| The app stops responding while the assistant fills in a form | "It froze" |
| Saying "yes" does nothing for a meeting that sends invites | "It didn't hear me" |
| A "yes" said while the read-back is still playing is ignored | "It didn't hear me" |
| The microphone pauses 30 seconds after a read-back | "It hung up" |
| Closing the panel ends the conversation | "I lost everything" |
| Ten minutes are gone after a few tasks, some of them silent | "The limit is broken" |
| It refuses to delete, or to touch a project | "It's useless" |
| It will not add rooms or lines yet | "It's broken" |
| It mentions something it remembered from last week | "What else is it keeping?" |

Every one of these is deliberate (`AGENT_SPEC.md` 4.2–4.5, 4.9). The guide exists to say
so at the moment it matters, in one sentence, and to give the longer answer to anyone who
wants it.

---

## 4. Decisions

All proposed. None has been confirmed.

| # | Topic | Proposed decision |
|---|---|---|
| G1 | Where help lives | In the panel first, a full page second. Both show the same content |
| G2 | Source of the content | One module in the API, served by a read endpoint and used by the assistant's own help tool. Not written twice, and not written in the frontend |
| G3 | Who sees what | Filtered on the server by role and by what is switched on. A member is not told how to admin-approve. Nobody is told about room and line edits until Release 2 is on |
| G4 | Examples | The idle panel shows things to say. Clicking one puts it in the text box. It does not send it and does not start a conversation |
| G5 | First open | A three-card introduction, shown once. It makes no sound and starts nothing |
| G6 | Help view | A view inside the panel, reachable from its header in every state. It never covers Stop, Approve, Reject, End or mute |
| G7 | Hints | One line, at the moment something new happens. One at a time, at most twice each, dismissible, never spoken |
| G8 | Asking the assistant | "What can you do?" and "how do I…?" are answered from the same content, with an offer to open the topic |
| G9 | Full page | `/help/assistant`, linked from the account menu and from the help view |
| G10 | What has been seen | Kept in the browser, per person. No server table |
| G11 | What's new | The content carries a version. A rise in it puts a dot on the help button and a short note at the top of the help view |
| G12 | Reading is free | Nothing in the guide uses the daily allowance, and all of it works when the allowance is spent. Asking the assistant aloud does use it, and the guide says so |
| G13 | Language | English only, as D24 |
| G14 | Voice | The guide is written in the app's own words: "supplement", "Approve", "Stop", "Start talking" |

---

## 5. Where help appears

### 5.1 The idle panel: things to say

The idle panel today shows a paragraph and a Start button. It gains a short list headed
**Try saying** (item 6 of the idle screen in `AGENT_DESIGN.md` 8.9). The same three
examples are shown again, quieter, under "Listening" in a conversation where nothing has
been said yet (`AGENT_DESIGN.md` 8.3), which is the moment a new user most needs them.
There they are reading matter only: the conversation is already live, so clicking one
still fills the text box and sends nothing.

- Three or four examples, chosen for the page the user is on. The browser already knows
  the route (the context reporter sends it).

  | Page | Examples lead with |
  |---|---|
  | Calendar | Scheduling and moving meetings |
  | A supplement | Things about "this one": its total, its status, archiving it, sending it for review |
  | Supplements list | Finding supplements, creating one |
  | Projects | Questions about a project. No write examples, because there are none |
  | Anywhere else | One of each |

- **Clicking an example puts it in the text box and focuses it** (G4). It is not sent.
  Most examples have a name or a time in them that has to be changed, and sending starts
  the meter. The user edits and presses Enter, or just reads it and says their own
  version aloud after pressing Start.
- A **More examples** link opens the help view at *What you can ask*.
- Examples the user's role cannot do are never shown (G3).

### 5.2 The first-open introduction

Shown the first time a person opens the panel in a given browser.

- Three cards inside the panel, in place of the idle content. Next, Back, and **Got it**
  on the last. **Skip** on every card. A link to the full guide on the last.
- It is silent and starts no conversation. A9 stands: the assistant never speaks first.
- Figures on the cards come from the server (the allowance is whatever the team set, not
  a hard-coded ten).
- Once dismissed it does not return, except through **Show the introduction again** in
  the help view.

The cards (draft wording in 6.3):

1. **Ask, by voice or by typing.** What it can do, in one sentence, and the two ways to
   start.
2. **Watch it work, then approve.** It fills in the real screen; the app is locked while
   it does; nothing is saved until you approve; Stop or Esc takes over.
3. **Four things to know.** Email needs a click. Your time per day. Closing the panel
   ends the conversation. It cannot delete anything.

**A safe first try.** The last card says: *ask for a meeting, look at the form it fills
in, then press Reject. Nothing is saved.* That is true of the product as specified, so no
practice mode is needed (section 13).

### 5.3 The help view

A help button in the panel header opens a view that replaces the body of the card (zone
2 in `AGENT_DESIGN.md` 8.1).

- **Top:** a search box that filters topics by title and text. Below it the topics, each
  a title and one line.
- **A topic:** rendered from the content blocks in 8.2. A Back control returns to the
  list. **Open the full guide** goes to `/help/assistant#<topic>` in the app column.
- **It never hides the controls** (G6). The header, the dock with Stop and the approval
  card, and the controls at the foot all stay where they are. Only the body is
  replaced, and returning to it is one click.
- **While a proposal is waiting**, the approval card stays pinned in the dock under the
  help view.
  Someone reading *why does this need a click?* can still see what they are approving.
- Opening help does not pause, mute or end anything. The conversation carries on and the
  meter runs as usual. The view says so in one line when a conversation is live.
- Available in every panel state, including *allowance used* and *ended*.

### 5.4 Hints at the moment of need

A hint is one line with a dismiss control, shown in the panel directly beside the thing
it explains.

Two kinds, and the difference matters:

**Always shown.** These explain a state the user is in. They are part of the interface,
not teaching, and they do not go away after the first time.

| When | Text |
|---|---|
| A click-only approval, because it sends email | "This sends email, so it needs a click. Saying yes will not approve it." |
| A click-only approval, because it changes who can edit | "This changes who can edit the supplement, so it needs a click." |
| A proposal downgraded by D43 | "It did not read all of this back, so this one needs a click." |
| The microphone is paused after a read-back | "Microphone paused, so your time is not used while you read. Tap to talk, or press Approve." |
| Under two minutes of allowance | "Two minutes left today." |

The current build shows one sentence for every click-only proposal, without the reason.
Telling lock, unlock, admin-approve and a D43 downgrade apart needs the server to say
why (8.4).

**These are not shown twice.** The approval card already carries a short line saying how
a proposal can be approved (part F in `AGENT_DESIGN.md` 8.6: "Sends email to 2 people.
Needs a click."). For the three approval rows above, that line *is* the hint. The longer
sentence in this table is what its **Why?** link opens with, above the *Approving*
topic. The paused-microphone and two-minutes rows are likewise the card's own line and
the header's countdown.

**Shown the first two times, then never.** These teach.

| Id | When | Text |
|---|---|---|
| `lock` | The app locks for the first time | "The app is locked while the assistant fills this in. Press Stop or Esc to take over." |
| `voice_ok` | First voice-or-click approval | "Say yes once it has finished reading this back, or press Approve." |
| `early_yes` | The server refuses a voice approval for timing | "That yes came before it finished reading. Say it again, or press Approve." |
| `handover` | First Stop with a form staged | "The form is yours now. Finish it and save it as you normally would." |
| `remembered` | First "Remembered:" notice | "It keeps a few facts about how you work. See or delete them in Profile." |
| `out_of_time` | The allowance ends with a proposal open | "Time is up for today. You can still approve or reject this by click." |
| `closing` | Hovering or focusing Close during a live conversation | "Closing the panel ends the conversation." |
| `dialog_open` | The assistant declines to act because the user has a dialog open | "Close the form you have open and it will carry on." |

Rules: at most one teaching hint on screen at a time; a teaching hint never appears over
an always-shown one; each has a **Learn more** link to its topic; none is spoken, because
speech uses the allowance and the assistant already says the essential part aloud.

### 5.5 Asking the assistant

People will ask the assistant about itself. It should answer correctly, briefly, and the
same way the written guide does.

- A read tool, **`get_help`**, takes a topic or a free-text question and returns the
  matching topic's *spoken* version: one or two sentences written for the ear (8.2).
- A control tool, **`show_help`**, opens the help view at a topic. It does not navigate
  the app and does not lock it.
- The instruction gains two lines: when asked what you can do or how something works,
  call `get_help` and answer from it; then offer to open the guide.
- `get_help` returns only what this user may do (G3), so the assistant cannot describe a
  capability the user does not have.

The existing instruction already lists what the assistant can and cannot do
(`app/agent/instruction.py`, `RULES`). That list stays, because the model needs it to
behave. What `get_help` adds is the *how*: approvals, the lock, the allowance, memory,
none of which the model can explain reliably from its rules alone.

### 5.6 The full guide page

`/help/assistant`, inside `AppShell`.

- Every topic on one page, with a contents list that follows the scroll position, and an
  anchor per topic.
- Linked from the account menu as **Assistant guide**, from the help view, and from the
  last introduction card.
- Shown only to people the assistant is offered to (the same check as the launcher).
  For anyone else the route is a normal not-found.
- It works at any window width. On a window too narrow for the launcher it says so at
  the top: the assistant needs a window at least 1024px wide.
- Printable with the browser's print command. No special print layout beyond hiding the
  app chrome.

Why a page as well as the help view: the panel is 400px wide and may be holding a live
conversation. A page is where someone reads the whole thing once, where a manager sends a
new starter, and the only place the wide tables (what needs a click) fit comfortably.

---

## 6. The content

### 6.1 Writing rules

- Second person, present tense, short sentences. Say what happens, then why.
- The app's own names for things, exactly as on screen (G14). Never "estimate".
- Every limit is a figure filled in by the server: the allowance, the idle timeout, the
  30-second window, the 30-minute cap, the 90-day retention. The copy holds a
  placeholder, so changing a setting cannot leave the guide wrong.
- Every refusal comes with where to do the thing by hand.
- No promise the product does not keep. "It never saves without your approval" is true
  and stays. "It always understands names" is not, and is not said.

### 6.2 Topics

| Id | Title | Answers |
|---|---|---|
| `start` | Starting and ending | Start talking, typing instead, the microphone prompt, mute, the speaker switch, End, closing the panel, one conversation at a time |
| `ask` | What you can ask | Meetings, supplements, questions, memory; examples for each |
| `cannot` | What it cannot do | Deletes, projects, team, settings, photos, exports; rooms and lines until Release 2. Where to do each by hand |
| `how` | How a change is made | Ask, watch, hear it read back, approve, saved |
| `approve` | Approving | Voice or click; what needs a click and why; when a spoken yes counts |
| `fix` | Correcting, rejecting and taking over | Say the correction; Reject; Stop and Esc; what happens to the form |
| `time` | Your time each day | What counts, what does not, the pause, the reset, what happens at zero |
| `memory` | What it remembers | What, what never, "remember that", "forget that", Undo, the Profile screen |
| `history` | History and privacy | What is kept, for how long, who can see it, what is sent to Google |
| `tips` | Being understood | Names, dates, email addresses, "this one", noisy places |
| `trouble` | When something goes wrong | Microphone blocked, no sound, launcher missing, connection lost, "it keeps asking" |
| `keys` | Keyboard | Esc for Stop; Enter to send |

### 6.3 Draft wording: introduction, examples

`{minutes}` and the other braces are filled in by the server.

**Introduction**

> **1. Ask, by voice or by typing**
> BuildCo Assistant schedules and changes meetings, creates and updates supplements, and
> answers questions about your work. Press **Start talking**, or type in the box.

> **2. Watch it work, then approve**
> It fills in the real screen while you watch. The app is locked while it does. Nothing
> is saved until you approve exactly what is on screen. Press **Stop** or Esc at any time
> to take over.

> **3. Four things to know**
> - Anything that sends email needs a click on **Approve**. Saying yes is not enough.
> - You have {minutes} minutes of conversation a day. The panel shows what is left.
> - Closing the panel ends the conversation.
> - It cannot delete anything.
>
> A safe first try: ask for a meeting, look at the form it fills in, then press
> **Reject**. Nothing is saved.

**Examples.** Each names the proposal kind or read tool it should lead to, which is what
the test in section 7 checks.

| Shown on | Example | Leads to |
|---|---|---|
| Calendar, anywhere | "Schedule a site visit with Maria tomorrow at 2 for 45 minutes" | `meeting.create` |
| Calendar | "Move my 3 o'clock to Thursday at 10" | `meeting.update` |
| Calendar | "What meetings do I have this week?" | `list_meetings` |
| Supplements list, anywhere | "Create a supplement for the Smith kitchen job" | `supplement.create` |
| Supplements list | "Which supplements are waiting on the reviewer?" | `search_supplements` |
| A supplement | "What's the total on this one?" | `get_supplement` |
| A supplement | "Archive this one" | `supplement.transition` |
| A supplement | "Send this one for review" | `supplement.submit` |
| A supplement | "Change the carrier to State Farm" | `supplement.update_details` |
| Projects | "What milestones are left on this project?" | `get_project` |
| Anywhere | "Remember that my meetings are usually 45 minutes" | `remember` |
| Anywhere | "What do you remember about me?" | `list_memories` |

### 6.4 Draft wording: topics

First drafts. They are checked by a person at G0-Human before anything is built.

**Starting and ending**

- Press **Start talking** to use your voice. Your browser asks for the microphone the
  first time.
- Or type in the box and press Enter. No microphone is needed. It still answers aloud
  unless you turn the speaker off.
- **Mute** stops it hearing you without ending the conversation. Use it when someone
  else talks to you.
- You can speak over it at any time. It stops and listens.
- **End**, closing the panel, refreshing the page or signing out all end the
  conversation. It is saved to your history. Anything waiting for approval is dropped,
  not saved.
- After {idle_warning} seconds of silence it asks if you are still there, and ends
  {idle_gap} seconds after that. A conversation ends at {cap} minutes whatever happens.
- You have one conversation at a time. Starting one in another tab ends the first.

**What you can ask**

- *Meetings:* schedule one; change its time, title, place or who is on it.
- *Supplements:* create one; change its details; archive, unarchive, recall, or mark it
  ready to resubmit; send it for review. {elevated_actions}
- *Questions:* anything you could look up yourself about supplements, meetings, projects,
  the team, the rate catalogue and the team's settings.
- *Showing:* "open the calendar", "show me the Smith supplement".
- It acts as you. It can see and do what you can, and nothing more.

**What it cannot do**

| It cannot | Do it here instead |
|---|---|
| Delete, trash or restore a supplement | The supplement's own menu |
| Cancel a meeting | The meeting, on the calendar |
| Change a project or its milestones | The project page |
| Invite, remove or change team members | Team |
| Change settings or the rate catalogue | Settings |
| Add photos, make the PDF report, export | The supplement editor |
| {rooms_and_lines_row} | The supplement editor, by hand or with the notes parser |

It will always tell you when it cannot do something. It is not able to be talked into it.

*The right-hand column was written without opening each screen. Every "do it here" is
checked against the running app at G0-Human before it is built.*

**How a change is made**

1. You ask.
2. It opens the real page and fills in the real form. The app is locked while it does,
   with a coloured frame and a **Stop** button.
3. It reads back what it is about to do: which record, the total or the date and time,
   who will be emailed, and anything unusual.
4. You approve.
5. It saves exactly what was on screen, and shows you the saved record.

What is on screen is what gets saved. If what you heard and what you see differ, trust
the screen and say what is wrong.

**Approving**

- For most changes, say **yes** or press **Approve**.
- These need a click, and saying yes will not do it:

  {approvals_table}

- A spoken yes counts only after it has finished reading the summary back. If you say
  yes early, or talk over the read-back, say it again at the end or press Approve.
- Sometimes it does not read everything back clearly. When that happens it asks for a
  click instead.
- After it finishes reading, the microphone stays open for {answer_window} seconds. Then
  it pauses so your time is not used while you read. Press **Tap to talk** or just click.
- A change left waiting for {expiry} minutes is dropped. Nothing is saved.

**Correcting, rejecting and taking over**

- Say or type what is wrong: "make it 4pm", "not Maria Lopez, Maria Chen". It fills the
  form in again and reads back the change.
- **Reject** closes the form. Nothing is saved.
- **Stop**, or the Esc key, unlocks the app at once. The form stays filled in and becomes
  yours: finish it and save it as you normally would.
- Stop never undoes something already saved. It tells you what was saved and what was
  not.

**Your time each day**

- You have {minutes} minutes of live conversation a day. The panel shows what is left.
- The clock runs whenever a conversation is live, whether anyone is speaking or not, and
  whether you are talking or typing.
- It does not run while the microphone is paused waiting for your approval, while you
  read your history, or while you read this guide.
- It resets at {reset_local} your time, every day, for everyone.
- When it runs out the conversation ends. A change already waiting for approval stays on
  screen and can still be approved or rejected by click.
- Owners and admins set the team's figure in Settings.

**What it remembers**

- It keeps a few lasting facts about you: what to call you, how you like answers, and
  habits such as your usual meeting length.
- It only remembers what you said or typed yourself. It never remembers something it
  read in a record.
- It never keeps passwords, prices, or personal details about other people.
- Each time it remembers something, the panel says **Remembered:** with an **Undo**.
- Say "remember that…" to add one, and "forget that…" to remove one. Changing or
  forgetting needs your approval.
- **Profile → What the assistant remembers** lists everything, with the words each one
  was based on and a delete button.
- When it fills something in from memory, the form says *from memory* and it tells you.

**History and privacy**

- Your past conversations are listed in the panel. You can read them. You cannot
  continue one.
- Only you can see your conversations. Owners and admins cannot.
- The written transcript is deleted after {retention} days. The list of what was
  proposed, approved and saved is kept, along with the few words you used to approve.
- No audio is stored by BuildCo.
- {google_sentence}

**Being understood**

- Say the weekday and the date: "Thursday the fifteenth at 2".
- For a supplement, say the client and the job, or the claim id.
- "This one" and "that meeting" mean what is open on your screen. With nothing open, it
  asks which.
- Type email addresses. It can take one by voice, but it has to spell it back to you.
- Ask for one thing at a time.
- In a noisy place, use headphones with a microphone, or type.
- It asks when it is not sure. That is deliberate: it never guesses a price, a person or
  a date.

**When something goes wrong**

| Problem | What to do |
|---|---|
| The round button is missing | Make the window wider than 1024px. If it is still missing, the assistant is not switched on for you |
| The microphone is blocked | Click the padlock or camera icon in the address bar, allow the microphone, then press Start talking again. Or type |
| You cannot hear it | Check the speaker switch in the panel, then your computer's volume |
| It hears itself or cuts itself off | Use headphones, or lower the volume |
| "Reconnecting" | It tries for {reconnect} seconds and carries on where it was. Nothing saved is lost |
| It says the supplement has unsaved changes | Let the editor finish saving, or fix the save error, then ask again |
| It will not act while a form is open | Close the form you opened, then ask again |
| It says someone was removed from the team | It cannot add them to a meeting. Say who you meant |

### 6.5 Placeholders

| Placeholder | Filled from |
|---|---|
| `{minutes}`, `{reset_local}` | The team's allowance and the next reset; the browser shows the reset in local time |
| `{idle_warning}`, `{idle_gap}`, `{cap}`, `{answer_window}`, `{expiry}`, `{reconnect}`, `{retention}` | The same server settings that enforce each limit |
| `{approvals_table}` | Built from the approval rules (section 7) |
| `{elevated_actions}` | "You can also lock, unlock and approve internally." for roles that can; nothing otherwise |
| `{rooms_and_lines_row}` | "Add or change rooms and line items" until the Release 2 tool is in the registry; then the row is dropped and *What you can ask* gains a line |
| `{google_sentence}` | The sentence about Google, once its wording is confirmed (GQ2) |

---

## 7. Keeping the guide true

A guide that drifts from the product is worse than none. Four mechanisms, all automatic.

1. **One source.** The content is a module in the API. The page, the help view, the
   introduction, the examples and the assistant's `get_help` all read it. There is no
   second copy to forget.
2. **Filtered by the tool registry.** The registry is already built per user
   (`app/agent/tools.py`, `build(host)`). An example or a "you can" line is tied to a
   tool or a proposal kind, and it is shown only if that tool is in *this user's*
   registry. Release 2 switching on is therefore what makes its guide entries appear.
3. **The click table is generated.** `{approvals_table}` is produced by asking the
   existing rules in `services/rules/agent_rules.py` (`approval_policy`,
   `CLICK_ONLY_TRANSITIONS`) about each kind. If a rule changes, the table changes.
4. **Tests that fail on drift:**
   - every proposal kind in `agent_rules.KINDS` has at least one example and appears in
     *What you can ask*;
   - every example names a kind or read tool that exists;
   - everything in `AGENT_SPEC.md` 5.5 (what does not exist) has a row in *What it
     cannot do*, and no example leads to one of them;
   - every placeholder in the content resolves, for each role;
   - the content never contains the word "estimate".

What these cannot check is whether the words are *right*. That is a person's job, once
before launch (G0-Human) and at each release after (G2-Human).

---

## 8. Architecture

### 8.1 Pieces

| Piece | Where | Responsibility |
|---|---|---|
| Content module | `apps/api/app/agent/guide.py` | Topics, examples, hints' topic links, version, what's new. Plain data |
| Builder | Same module | Applies role, registry and placeholders; returns the guide for one user |
| Endpoint | `GET /api/v1/agent/guide` on `buildco-api` | The built guide as JSON. Refused for anyone the assistant is not offered to |
| `get_help`, `show_help` | `app/agent/tools.py` | 5.5 |
| `useAgentGuide` | `src/api/queries/agent.ts` | Fetches and caches the guide; long stale time |
| Block renderer | `src/features/agent/guide/` | Draws content blocks. Used by the help view and the page |
| Help view, introduction, hints, examples | `src/features/agent/guide/` | 5.1 to 5.4 |
| `AssistantGuidePage` | Same folder; route in `router.tsx` | 5.6 |
| Seen state | `src/features/agent/guide/seen.ts` | 8.5 |

The endpoint is on `buildco-api` because every REST endpoint is (`AGENT_SPEC.md` 6.2).
The tools run in `buildco-agent`. Both are the same image, so both import the same
module and there is nothing to keep in step.

### 8.2 Content shape

```
Guide
  version        integer, raised by hand when the content changes meaningfully
  whats_new      [{version, text}]         newest first, at most five
  topics         [Topic]
  examples       [{id, text, where: [page], leads_to}]
  approvals      [{label, approval, reason}]   the generated click table
  limits         {minutes, reset_at, cap, ...}  the resolved figures

Topic
  id, title, summary
  spoken         one or two sentences for the assistant to say
  blocks         [Block]

Block            one of:
  p              a paragraph
  list           bullet points
  steps          numbered steps
  say            things to say, drawn as quoted examples
  table          two columns only: a thing, and what to do about it
  note           a callout, tone info or warning
  approvals      the generated click table
```

Text may contain `**bold**` for the names of controls and nothing else. There is no
Markdown renderer in the frontend today and this does not add one: a block is typed data
and the renderer is a few small components. No HTML ever comes from the server.

### 8.3 Tools

| Tool | Kind | Input | Returns |
|---|---|---|---|
| `get_help` | Read | A topic id, or a question | The best topic's `spoken` text and its id. For a question, the match is by keyword over titles and summaries, done by the server, not the model |
| `show_help` | Control | A topic id | Sends `ui {action: "help", topic}`. Does not lock the app |

Neither needs approval. Neither writes anything. The registry test in `AGENT_SPEC.md`
5.5 is unaffected.

### 8.4 Protocol

Two additions to `AGENT_SPEC.md` 6.7:

| Direction | Frame | Change |
|---|---|---|
| ↓ | `ui {action: "help", topic}` | New action: open the help view at a topic |
| ↓ | `proposal {…, approval_reason}` | New field when `approval` is `click`: `sends_email`, `changes_access` or `readback_unverified`. The always-shown hints in 5.4 need it. `AGENT_DESIGN.md` needs it too |

### 8.5 What has been seen

Kept in the browser's local storage, under a key that includes the person's profile id.

```
{ intro: <guide version when dismissed>,
  hints: { lock: 2, voice_ok: 1, … },      times shown
  whats_new: <guide version last read> }
```

- No server table and no migration.
- A new browser, or cleared storage, shows the introduction again. That is acceptable: it
  is three cards and a Skip.
- Two people sharing a browser each have their own, because the key carries the profile.
- The speaker switch is already remembered per browser (`AGENT_SPEC.md` 4.2). This
  follows the same choice.

---

## 9. Accessibility

- The help view and the page use real headings, in order. The topic list is a list of
  links.
- Opening the help view moves focus to its heading. Closing it returns focus to the help
  button.
- The introduction is a group with a label and "card 2 of 3" in text, not only dots.
  Focus moves to each card's heading as it appears.
- Hints are announced politely, once. A hint that reappears is not announced again.
- Examples are buttons. Their accessible name says what activating does: "Put in the
  text box: …".
- Nothing depends on colour alone, and nothing here moves unless the existing
  reduced-motion rule allows it.
- Help is fully usable from the keyboard while the app column is locked, because it
  lives in the panel.

---

## 10. Measuring whether it works

No new browser telemetry. The server already logs what shows where people struggle
(`AGENT_SPEC.md` 6.14), and the guide is judged against those:

| Signal | The guide is working if |
|---|---|
| `agent_voice_commit_rejected` for timing | It falls after a person's first few conversations. That is what `early_yes` and *Approving* teach |
| `agent_tool_refused` for out-of-scope requests | It falls per person over time. That is what *What it cannot do* teaches |
| Proposals handed over | Not rising. Stop should be a choice, not an escape |
| Calls to `get_help`, by topic (new, logged with the topic id only) | The busiest topic is the one whose hint or copy needs work |

One event is added: `agent_help_asked {topic}`. No transcript text, as everywhere else.

During the pilot, the two or three people are simply asked: what surprised you? Each
answer is checked against section 3.

---

## 11. Testing

**API**

- The drift tests of section 7.
- The endpoint: refused for someone outside the audience; a member's guide has no
  admin-approve, lock or unlock; an owner's has all three.
- Placeholders resolve from changed settings: set the allowance to 5 and the guide says 5.
- `get_help` returns only topics in the caller's guide; a question that matches nothing
  returns the *What you can ask* topic, never an invented answer.

**Frontend**

- Introduction: shown once; Skip and Got it both record it; shown again from the help
  view.
- Examples: change with the route; clicking fills and focuses the text box and sends
  nothing (assert no session is created).
- Help view: opens in every panel state; with a proposal open the approval card and its
  buttons are still in the document and enabled; with the app locked, Stop is still
  reachable.
- Hints: a teaching hint stops after two showings; an always-shown hint does not; only
  one teaching hint at a time.
- `ui {action: "help"}` opens the right topic.
- The page: every topic has an anchor; not-found for someone outside the audience.

**By hand (G1-Human).** Read every topic in the running app, in the panel at 400px and on
the page. Try every example on the page it is offered on. Check each figure against
Settings.

---

## 12. Delivery plan

### Ownership

| Phase | What | Owner |
|---|---|---|
| G0-Human | Read the draft wording in section 6. Correct terms and tone. Settle GQ1 to GQ4 | Human |
| G1-Claude | Everything in sections 5 to 9 and 11, in one pass | Claude |
| G1-Human | The by-hand check above. Review, commit, release | Human |
| G2-Human | At each later release: re-read the guide against what changed. A line in `RELEASE.md` | Human |

### G1-Claude, in one pass

The content module with the wording agreed at G0; the builder and its filters; the
endpoint; `get_help` and `show_help` with the two instruction lines; the `help` action
and `approval_reason`; the block renderer; the help view, introduction, hints and
examples; the page and its route and menu link; the seen state; all tests; a note in
`RELEASE.md`. Left uncommitted on its own branch.

### When

It needed Release 1's breadth to exist first (history, memory, the allowance and the
remaining proposal kinds), because it describes them. That is built (`d9af970`).

**It should land before the assistant is opened to everyone** (`2-Human-2` in
`AGENT_SPEC.md` section 9). A pilot of three people can be taught in person. A whole team
cannot, and section 3 lists what they will each take for a fault.

**It lands after `AGENT_DESIGN.md`.** The design is built first, so the help view, the
introduction, the hints and the examples are built once, in the new look and with its
motion (`AGENT_DESIGN.md` 10). The design leaves the guide's places empty until then: the
**Try saying** block, the introduction, and the help button's view.

---

## 13. Out of scope

| Excluded | Why |
|---|---|
| Video or animated walkthroughs | Stale after the first design change, and nobody maintains them |
| A tour that highlights parts of the app in turn | Needs a library or a lot of code, and the assistant's own work mode already shows how it works |
| A practice mode with fake records | Not needed: ask, look, Reject is a real and safe first try |
| Translation | D24 |
| Guide content edited by owners in Settings | A content system for a dozen topics is not worth building |
| Help for the rest of the app | This is the assistant's guide. A general help centre is a separate decision |
| The assistant offering tips unprompted | A9: it never speaks first |

---

## 14. Assumptions and open questions

### Defaults chosen without asking

| # | Assumption |
|---|---|
| GA1 | Clicking an example fills the text box. It does not send |
| GA2 | Seen state is per browser, not per account |
| GA3 | A teaching hint is shown twice, not once: the first time people are busy looking at something else |
| GA4 | The guide is hidden from people the assistant is not offered to, pilot included |
| GA5 | Asking the assistant for help is metered like any other talk |
| GA6 | The page is reachable below 1024px, with a note that the assistant itself is not |
| GA7 | Content changes ship with a release. There is no way to edit it in production |

### Open

| # | Question | Needed by |
|---|---|---|
| GQ1 | Should people outside the pilot see the guide page, as an announcement of what is coming? Default: no (GA4) | G0-Human |
| GQ2 | The exact sentence about Google. Speech is sent to Google's Gemini service on Vertex AI to be understood. What may be said about how long Google keeps it has to come from the terms of the Google Cloud agreement in force, and is not something this document can assert | G0-Human |
| GQ3 | Who owns the wording after launch, and re-reads it at each release (G2-Human) | G0-Human |
| GQ4 | Whether the introduction should mention the pilot ("you are one of the first to try this") while the audience is `pilot` | G0-Human |

---

## 15. Where this touches `AGENT_SPEC.md`

`AGENT_SPEC.md` is not rewritten. Its companion-documents section points here for each
of these.

| Section | What this document adds |
|---|---|
| 3, Release 1 | Add: a user guide in the panel and at `/help/assistant` |
| 4.1, panel states | *Idle* gains examples and, on first open, the introduction. Add a state: **Viewing help**, available from every other state |
| 4.4 | The card's explanation of a click-only approval depends on the reason (5.4 here) |
| 4.10 | Each row's message links to its guide topic |
| 5.1 | Add `get_help` |
| 5.4 | Add `show_help` |
| 6.3, system instruction | Add the two lines in 5.5 here |
| 6.7 | Add the `help` action to `ui`; add `approval_reason` to `proposal` |
| 6.8 | Add the guide folder and its pieces (8.1 here) |
| 6.10 | Add `GET /api/v1/agent/guide` |
| 6.14, log events | Add `agent_help_asked` |
| 8 | Add the tests of section 11 here |
| 9 | Add phases G0 to G2; note that G1 precedes `2-Human-2` |
| 12 | Add GA1 to GA7 |
