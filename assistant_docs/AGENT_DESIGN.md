# BuildCo Assistant — Design Specification

**Status:** revision 2, awaiting sign-off. Once signed off it is the build contract for
the look of the assistant (phase D0-Human, section 17).
**Written:** 2026-10-11. **Revised:** 2026-10-11, after Release 1 was finished and its
screens were reviewed.
**Baseline:** the assistant code on `feature/assistant-release-1` at commit `d9af970`
("Finish Release 1 of BuildCo Assistant"), and `AGENT_SPEC.md` as it stands beside this
file.

How BuildCo Assistant looks, moves and reads: the launcher, the panel in every state, the
approval card, and the app while the assistant is working in it.

**This document changes how things look, not what they do.** Every behaviour in
`AGENT_SPEC.md` section 4 stands. Section 14 lists the rules a build must not bend, and
section 16 lists the three small places where the look needs something new from the
server.

**How it fits with the other documents.** `AGENT_SPEC.md` is the main document and wins
on behaviour and safety. This document wins on appearance and motion. `AGENT_GUIDE.md`
wins on help content. There is no V2 of the specification: `AGENT_SPEC.md` points here.

### What revision 2 changed

| Change | Where |
|---|---|
| The look is **expressive but calm**, no longer deliberately quiet: a living orb, a soft aura, spring motion, a choreographed approve moment | 4, 6.1, 10 |
| The panel is a **floating card**, inset from the window, not an edge-to-edge sidebar | 8.1 |
| The launcher moves to the **bottom-right** and opens into the card | 7 |
| The accent is settled: **violet**, blending from brand blue (was open question DQ1) | 6.2 |
| Nine problems found in the Release 1 screens are added, each with its answer | 3 |
| The static mock is dropped. The signed-off document is the gate and the state gallery is the review surface | 15.2, 17 |
| "What exists today" re-read against the finished Release 1 | 2 |

---

## 1. Summary

| | |
|---|---|
| **Goal** | A panel that looks modern and finished, where it is always plain who is talking, what the assistant is doing, and what is about to be saved, and that is a pleasure to watch work |
| **Stays** | BuildCo's own design system: Archivo and Sora, the grey ramp, the brand blue, the 10px card radius, dark mode by repainting variables |
| **New** | A living orb as the assistant's face, one accent colour that means "the assistant's, not saved yet", a floating card with a fixed anatomy, a redesigned approval card, and a full motion vocabulary |
| **Method** | This document is signed off, then built in one pass. A gallery of every state is built first and is how the result is reviewed |
| **Cost** | Frontend only, no new dependencies, plus two small fields on the `proposal` frame that the build works without |

---

## 2. What exists today

Read from the code at `d9af970` and from the five screenshots in `FE_images_assistant/`.

| Piece | As built | File |
|---|---|---|
| Launcher | A 48px brand-blue circle with a microphone glyph, bottom-left. The label is the browser's own `title` tooltip | `AgentLauncher.tsx` |
| Panel | 400px, docked to the right edge at full height with a left border. Three stacked areas: a title bar, a scrolling body, a footer | `AppFrame.tsx`, `AgentPanel.tsx` |
| Header | "BuildCo Assistant" and a close button. No status | `AgentPanel.tsx` |
| Idle | A paragraph of explanation, "8 min left today.", a full-width **Start talking** button, then the list of past conversations | same |
| Live, nothing said yet | **An empty body.** Only the footer controls show that anything is happening | same |
| Banners | Up to three strips under the header: working (pale blue, with a red Stop), reconnecting (amber), microphone paused (grey, with Tap to talk) | same |
| Transcript | Chat bubbles. The user's are solid brand blue with white text; the assistant's are grey. Words still arriving are shown at 70% opacity | same |
| Steps | A text list with "✓" and "•" characters | same |
| Approval card | A card with a 2px blue ring, inside the scrolling body: a title, the summary, then a block that depends on the kind (who is on the meeting, old → new details, a memory now and after), warnings, one line of small print, Reject and Approve | same |
| Outcome | The app's generic `Alert` in green, red, amber or blue. Replaced when the next proposal arrives | same |
| Remembered | A grey row, "Remembered: …", with an Undo link | same |
| Controls | Small text buttons: "Mute", "Speaker on", "End". A 64px bar as the microphone meter. A countdown appears only under two minutes | same |
| Text box | A single-line input and a Send button | same |
| Ended | The transcript, the outcome alert, why it ended, the time left, **Start a new conversation**, then the whole history list | same |
| History | Rows of a title (the first thing said), the date, the metered seconds and "1 change saved". One conversation opens in place, with action cards inline | `AgentHistory.tsx` |
| Lock | A 4px inset blue ring around the app column, and a blue pill at the top: "BuildCo Assistant is working" with Stop | `AppFrame.tsx`, `AgentLauncher.tsx` |
| Staged form | The real dialog with a pale blue strip, "Filled in by BuildCo Assistant. Not saved yet.", its body made inert, its footer removed, over the dialog's usual dark scrim | `Modal.tsx` |
| Memories | A card on the Profile page: each memory, its category and date, the words it came from, a Delete button | `AgentMemories.tsx` |

It works, and it was built to prove the behaviour. It is not yet designed.

---

## 3. What is wrong with it

Specific, so each can be checked off. The last column is where this document answers it.

### From the code

| # | Problem | Answer |
|---|---|---|
| 1 | **The assistant has no presence.** Nothing shows whether it is listening, thinking or speaking. A 64px grey bar is the only sign the microphone is live. In a voice product that is the most important thing on the screen | 6.1 |
| 2 | **One blue means four things.** The user's bubbles, the Approve button, the lock frame and the approval card's ring are the same blue as every link and primary button in the app. Nothing says "this is the assistant's, and it is not saved" | 6.2 |
| 3 | **The approval card scrolls away.** It sits in the transcript. A few more lines of conversation push the thing being approved off the screen while the assistant is still asking about it | 8.1 |
| 4 | **The approval card is a paragraph.** The date, the place and the people are buried in a sentence. The eye cannot check them in one pass | 8.6 |
| 5 | **The same small print for every click-only approval.** "Saying yes will not approve it" is shown without the reason, which differs: it sends email, it changes who can edit, or the read-back was not verified | 8.6 |
| 6 | **Time left is easy to miss.** It is a sentence in the idle body, then nothing at all during the conversation until under two minutes | 8.2 |
| 7 | **Results vanish.** "Saved." is replaced by the next proposal, so a conversation that made three changes shows one outcome | 8.4 |
| 8 | **Controls are words, and small.** 32px text buttons are below a comfortable touch size on a tablet, which D26 names as a first-class device | 8.7 |
| 9 | **The lock is loud and unexplained.** A hard 4px ring. Clicking the locked app does nothing and says nothing | 9.1 |
| 10 | **The launcher's label is a native tooltip:** slow to appear, unstyled, and absent on touch | 7 |
| 11 | **Text glyphs for icons.** "✓" and "•" render differently on every platform | 15.1 |
| 12 | **The panel re-renders on every microphone reading.** `micLevel` is React state in the provider, so every consumer redraws many times a second | 6.1 |

### From the screenshots

| # | Problem | Seen in | Answer |
|---|---|---|---|
| 13 | **A live conversation with nothing said yet is a blank panel.** No sign it is connected, listening, or waiting for the user. This is the first thing every new user sees after pressing Start | `talking with agent.png` | 8.3 |
| 14 | **The read-back is on screen twice,** word for word: once as a chat bubble and once in the approval card directly under it | `createing_a_meeting.png` | 8.3 |
| 15 | **A staged form shows placeholders as if they were values.** "12 Oak Street" in Location is the field's placeholder (`MeetingModal.tsx:421`), not something the assistant filled in. On a read-only form it reads as part of what is being approved. `NewEstimateModal.tsx` has three more | same | 9.2 |
| 16 | **The whole app goes dark while a form is staged.** The dialog's scrim (45% black, 65% in dark mode) plus the frame makes the app look switched off, when the user is being asked to look at it | same | 9.2 |
| 17 | **Stop is shown twice,** once in the pill over the app and once in a banner in the panel, in two colours | same | 8.5 |
| 18 | **History rows read as broken.** "0 s" appears on conversations that plainly lasted longer, because the figure is metered audio seconds. Titles are the first thing said, so they are "Hello." and "Untitled" | `assistant_opened_on_side.png`, `after_a_conversation_ends.png` | 8.4 |
| 19 | **The idle panel is a paragraph, a button and empty space.** Nothing invites a first request | `assistant_opened_on_side.png` | 8.9 |
| 20 | **The ended panel has no hierarchy.** Transcript, outcome, ending line, time left, button and the full history run together under a native scrollbar | `after_a_conversation_ends.png` | 8.9 |
| 21 | **The lock pill sits on the navigation bar** | `createing_a_meeting.png` | 9.1 |

---

## 4. Principles

1. **State first.** At a glance, without reading: is it listening, thinking, speaking,
   working, waiting for me, or stopped? Every state has a look and a two-word label.
2. **The approval is the centre.** When something is waiting to be saved, it is the most
   prominent thing in the panel and it cannot scroll away.
3. **The app is the stage.** The real screen shows the change. The panel does not
   compete with it or repeat it at length.
4. **One colour for "the assistant's, not saved yet".** Used nowhere else. Blue stays
   "your action". Green stays "saved".
5. **Never colour alone.** Every colour meaning is also a label, an icon or a line style.
6. **Motion has a job, and may be beautiful doing it.** Every movement marks a change of
   state, shows where something came from or went, or shows that the assistant is alive
   and listening. Within that, it is designed, not minimal: springs, staggers and one
   signature moment when a change is saved (10.3). What is ruled out is motion with no
   subject: nothing bounces for attention, nothing decorates a still screen.
7. **Expressive in one place, calm everywhere else.** The orb, its aura and the launcher
   carry the personality: gradient, glow and continuous movement. Every other surface is
   flat and thin-lined, so the orb reads. No glass, no blurred backdrops, no sparkle
   icons.
8. **Built from what the app has.** Tokens and components the app already uses, extended
   where needed. The panel should look like part of BuildCo, not a widget dropped on it.
9. **Nothing pretty may cost a control.** No animation delays Approve, Reject, Stop, End
   or mute, hides them, or moves them while they could be pressed.

---

## 5. Decisions

DS1 to DS15 are from the first draft, revised where marked. DS16 onwards are new.

| # | Topic | Decision |
|---|---|---|
| DS1 | The mark | *Revised.* The assistant's face is a living orb that shows its state. It replaces the microphone glyph on the launcher and appears wherever the assistant is named |
| DS2 | Accent | *Confirmed.* A new `assistant` colour, violet, meaning "the assistant's, not saved yet". Brand blue is no longer used for the lock, the staged marks or the card's border |
| DS3 | Line style | "Not saved yet" is also always a dashed outline and the words, because violet and blue are the same lightness and look alike to many colour-blind people |
| DS4 | Panel anatomy | *Revised.* Four fixed zones: header, body, dock, controls. The approval card and the step list live in the dock, pinned |
| DS5 | Transcript | The assistant's words are plain text. The user's are a neutral grey bubble. No saturated colour in the transcript |
| DS6 | Approval card | Structured facts first, then exceptions, then the server's summary word for word, then how to approve |
| DS7 | Results | Each outcome is a small receipt left in the transcript where it happened |
| DS8 | Controls | Icon buttons at touch size, each with a visible state and an accessible name. End keeps its word |
| DS9 | Lock | *Revised.* A thin violet frame and a banner, under the navigation bar, that names the current step. A click on the locked app makes the banner answer |
| DS10 | Staged forms | *Revised.* A dashed violet banner, a mark on every filled field, a chip for where a value came from. Placeholders are not shown. The scrim is light |
| DS11 | After a save | The saved record is tinted green for about two and a half seconds. Violet becomes green: not saved becomes saved |
| DS12 | Motion | *Revised.* A full vocabulary: five durations, three curves, a choreography table. Transform and opacity only, with one named exception. Reduced motion is honoured everywhere, including the orb |
| DS13 | Theme | The panel follows the app's light or dark theme. It is not a permanently dark panel |
| DS14 | Dependencies | None added. CSS, inline SVG, a small presence hook, and the reducer that already exists (10.5) |
| DS15 | Process | *Revised.* This document is signed off, then built in one pass. The gallery of states (15.2) is built first and is how a person reviews the result. There is no separate static mock |
| DS16 | Panel shape | A floating card: 400px wide, inset 12px from the window, 16px corners, one shadow. The app still reflows beside it and is never covered at 1024px and up |
| DS17 | Launcher | Bottom-right. The card opens out of it and closes back into it. This supersedes the corner in `AGENT_SPEC.md` D15 |
| DS18 | One orb at a time | Before anything has been said, a large orb is the centre of the body. When the conversation starts it travels to the header. The panel never shows two |
| DS19 | Stop | One Stop in each place a person may be looking: in the pill over the app, and in the dock's header in the panel. Both are the same secondary button. The panel's working banner goes |
| DS20 | The read-back turn | While its proposal is in the dock, the assistant's spoken read-back is clamped to two lines in the transcript, with a control to show all of it. The card is the full statement |
| DS21 | History rows | Grouped by day. A duration is shown only when there is one worth showing. A row says what was saved, not only what was said first |
| DS22 | Aura | A faint wash of the state's colour behind the orb. The only glow in the design, and never on a control |
| DS23 | Ending | A closing card that says why it ended and what was saved. The history list moves behind its own button |

---

## 6. The assistant's identity

### 6.1 The orb

A circle that is visibly alive. It is the assistant's face everywhere: the launcher, the
panel header, the idle and listening screens, the lock banner, the banner on a staged
form, and beside "Remembered".

**How it is built.** Layers, back to front:

| Layer | What it is | What moves |
|---|---|---|
| Halo | A soft radial fade of `assistant-500` to transparent, 1.5 times the orb's size | Its scale and opacity follow the audio level |
| Core | A disc with a diagonal blend from `brand-500` to `assistant-500` | Its scale, a few percent, with the level |
| Blobs | Three soft-edged circles inside the disc, clipped to it: `brand-300`, `assistant-300` and `assistant-400` | Each drifts on its own slow loop. The loop lengths share no common factor (7s, 11s, 13s), so the pattern never visibly repeats |
| Highlight | A small white fade at the upper left | Nothing |
| Sign | The state's own drawing: bars, an arc, a ring, a pause symbol | Depends on the state |

The soft edges are radial gradients, not the `blur` filter, which is expensive to
animate. Everything that moves is a transform or an opacity.

**States.**

| State | The orb | Label |
|---|---|---|
| Resting (idle, ended) | Blobs drift at a quarter speed. No halo | none |
| Connecting | An arc travels round the rim; the blobs gather to the centre | "Connecting" |
| Listening | The halo and core follow the microphone level, quick to rise and slow to fall | "Listening" |
| Thinking | The blobs orbit quickly and the core breathes, about once every two seconds. Halo dim | "Thinking" |
| Speaking | Five rounded white bars inside the disc follow the level of the voice being played; the halo follows it too | "Speaking" |
| Working | A steady arc round the rim; blobs slow | "Working" |
| Waiting for approval | Still disc, with a full ring that empties over the answer window | "Waiting for you" |
| Paused | A hollow grey circle with a pause symbol | "Microphone paused" |
| Muted | A grey disc with a line through a microphone | "Muted" |
| Reconnecting | An amber dashed ring, turning slowly | "Reconnecting" |
| Time used | A grey disc | "Back at 5:00 PM" |

- A change of state crossfades over 220ms. Gradients are never animated; the coloured and
  grey versions are two layers whose opacity changes.
- The label is real text, always shown beside or under the orb. The orb itself is hidden
  from screen readers; the label is what they read, in a polite live region.
- **Sizes:** 20px in a line of text, 32px in the header, 56px on the launcher, 96px as
  the centre of the body (8.3). At 20px there are no blobs and no bars: a blended disc
  and, for a working state, the arc.
- **With reduced motion,** nothing moves: each state is a different still drawing, and
  the label carries the rest.
- **It loops only when it can be seen.** The loops stop when the tab is hidden and when
  the panel is closed. The launcher's orb is still until it is hovered or focused.
- **The level never touches React.** The microphone and playback levels are written to
  two CSS variables, `--mic-level` and `--voice-level`, on the card's root element from
  one animation frame loop, at most thirty times a second, smoothed in that loop (rise
  in about 60ms, fall in about 240ms). The orb and the microphone button read them. The
  panel does not re-render (problem 12).

**Where the states come from.** Nothing new from the server.

| State | Known from |
|---|---|
| Listening | A live conversation, not muted, and the assistant not speaking |
| Speaking | The playback buffer is not empty. Its level is measured in the playback worklet, which today reports only when playback ends (`audio.ts`). The capture worklet already reports a level |
| Thinking | From the user's final transcript line, or a typed send, until the first audio arrives. The spike measured this gap at 1.3 to 1.5 seconds |
| Working, waiting, paused | The `mode`, `proposal` and `audio` frames |

### 6.2 The accent colour

A new token family, `assistant`. The values are Tailwind's violet ramp, so they sit
naturally beside the existing ramps.

| Token | Light | Use |
|---|---|---|
| `assistant-50` | `#f5f3ff` | Fill of a staged field, a staged banner |
| `assistant-100` | `#ede9fe` | Borders on those fills |
| `assistant-300` | `#c4b5fd` | Accent text in dark mode; dashed outlines; an orb blob |
| `assistant-400` | `#a78bfa` | An orb blob only |
| `assistant-500` | `#8b5cf6` | Frames, rings, the orb, the aura. Not for text |
| `assistant-600` | `#7c3aed` | Accent text in light mode; the lock banner's fill |
| `assistant-700` | `#6d28d9` | Text on `assistant-50` |

In dark mode `assistant-50` and `assistant-100` are re-mixed, as the other tints in
`styles/index.css` are: a dark, low-chroma wash of the hue (around `oklch(28% 0.06 295)`
and `oklch(34% 0.08 295)`), with `assistant-300` supplying the readable text.

Measured contrast:

| Pair | Ratio | Enough for |
|---|---|---|
| White on `assistant-600` | 5.7 | Text |
| `assistant-700` on `assistant-50` | 6.5 | Text |
| `assistant-600` on white | 5.7 | Text |
| White on `assistant-500` | 4.2 | Icons and large text only |
| `assistant-500` on white | 4.2 | Frames, rings, icons |
| `assistant-300` on the dark surface | about 9 | Text |
| `assistant-500` on the dark surface | about 4 | Frames, rings, icons |
| `assistant-600` against `brand-600` | 1.1 | **Nothing.** They are the same lightness |

The dark figures use an approximation of the dark surface and are measured again in the
build.

**The last row is why DS3 exists.** Violet and brand blue differ in hue only. To someone
with red-green colour blindness they can look the same. So the accent is never the only
signal: "not saved yet" is always also a dashed line and those words.

**What each colour means, everywhere in the assistant:**

| Colour | Means | Examples |
|---|---|---|
| Violet, dashed | The assistant's, not saved yet | The lock frame, a staged form's banner, a filled field, the approval card's edge |
| Blue | Your action | Approve, Start talking, Send |
| Green | Saved | A receipt, the tint on a saved record |
| Amber | Look at this before you approve | An exception, a warning, low time, reconnecting |
| Red | It failed, or this stops something | A failed save, End |
| Grey | Everything else | Text, the user's bubbles, borders |

### 6.3 The aura

A soft radial wash of colour behind the orb, drawn on the card's own surface. It is what
makes the panel feel lit from within without putting a glow on anything that can be
pressed.

| Where | Shape | Colour | Strength |
|---|---|---|---|
| Behind the 96px orb (idle, connecting, listening before anything is said) | A circle about 320px across, centred on the orb | `brand-500` blending to `assistant-500` | 10% in light, 16% in dark |
| Behind the header, during a conversation | An ellipse across the top 120px of the card | The state's colour: violet while live, amber while reconnecting, none when ended | 6% in light, 10% in dark |

It is a still gradient. Only its opacity changes, over 480ms, when the state does. It is
never placed behind text smaller than 14px.

### 6.4 Type, shape, depth

Nothing new in type. The rules for using what exists:

| | |
|---|---|
| Panel title | Sora, 15px, semibold |
| Greeting on the idle screen | Sora, 20px, semibold. With the title, the only Sora in the panel |
| Card titles | Archivo, 14px, semibold |
| Body and transcript | Archivo, 14px on a 20px line |
| Labels and meta | Archivo, 12px on a 16px line, `gray-500` |
| Numbers | The existing `tnum` utility wherever money, times or countdowns appear |
| Radius | 16px for the panel card and the text box. 10px for cards inside it, the existing `rounded-card`. 18px for the user's bubbles. Fully round for the orb, icon buttons and chips |
| Lines | 1px `gray-200`. The card's outline, zone dividers, inner card outlines |
| Spacing | A 4px grid. 16px panel padding. 12px inside cards. 8px between related things, 16px between unrelated |

Two shadows, as tokens:

| Token | Light | Dark | Used on |
|---|---|---|---|
| `shadow-panel` | `0 8px 32px -8px rgb(0 0 0 / 0.18), 0 2px 6px rgb(0 0 0 / 0.06)` | `0 12px 40px -8px rgb(0 0 0 / 0.6)` | The panel card |
| `shadow-float` | `0 6px 20px -4px rgb(0 0 0 / 0.25)` | `0 8px 24px -4px rgb(0 0 0 / 0.7)` | The launcher, the lock banner, the Latest pill |

A shadow barely shows on a dark page, so in dark mode the card is also told apart by its
surface (`surface` on `canvas`) and its 1px outline. Nothing inside the card has a
shadow.

---

## 7. The launcher

- **56px, bottom-right,** 20px from each edge (DS17). The orb at rest, with
  `shadow-float`.
- **Hover or keyboard focus:** the orb wakes (its blobs drift, its halo blooms) and a
  label slides out to its left as part of the button: **Ask BuildCo Assistant**. This
  replaces the native tooltip. On touch there is no hover, and the orb alone is the
  button.
- **Pressed:** it scales to 96% for the length of the press.
- **First visit:** one ring pulses out from it, once, the first time it is shown in a
  session. It never pulses again and never loops.
- **Opening.** The card grows out of the launcher's corner (10.3). The launcher is not
  shown while the panel is open, as built.
- **Time used:** the orb is grey and the label reads **Back at 5:00 PM**. It still opens
  the panel, because history and memory still work.
- **Room for it.** A fixed button in the corner covers whatever a page puts there. While
  the launcher is showing, the app's main area gets 88px of bottom padding.
- **Toasts** are centred at the foot of the window today (`Toast.tsx`), so the new corner
  does not collide with them. While a panel is open they are centred on the app column
  instead, so one cannot land half under the card.

---

## 8. The panel

### 8.1 Anatomy

A floating card (DS16).

```
 app column (reflows)        12px  ╭──────────────────────────────────────╮  12px
                                   │ ◉  BuildCo Assistant   8 min  ?  ✕   │  1 header, 56px
                                   │    Listening                         │    status line
                                   ├──────────────────────────────────────┤
                                   │                                      │
                                   │   transcript, receipts, notices      │  2 body, scrolls
                                   │                                      │
                                   ├──────────────────────────────────────┤
                                   │ 3 steps ✓                      Stop  │  3 dock, only when
                                   │ ╭┄┄┄┄ approval card ┄┄┄┄╮            │    there is work
                                   ├──────────────────────────────────────┤
                                   │ ╭──────────────────────────────────╮ │  4 controls
                                   │ │ Type a message                   │ │
                                   │ │ mic  speaker            End   ↑  │ │
                                   │ ╰──────────────────────────────────╯ │
                                   ╰──────────────────────────────────────╯
                                                                     12px from the foot
```

**Geometry.**

| | |
|---|---|
| Card | 400px wide, as tall as the window less 24px, 16px corners, 1px `gray-200` outline, `surface` fill, `shadow-panel`. Its contents are clipped to the corners |
| Space it takes | 424px of the window: a 12px gap, the card, and 12px to the window's edge. The page ground (`canvas`) shows round it |
| Position | Sticky, 12px from the top, so it stays put while the page scrolls |
| At a 1024px window | The app column is 600px. It was 624px with the docked panel; both are under the first container breakpoint (`app-sm`, 640px), so no page changes layout because of this |
| Below 1024px | *Superseded 2026-10-17 by the phone layout below.* A live conversation's card is never hidden (`AGENT_SPEC.md` 4.1). It overlays the app's right side with the same inset and shadow, at most the window's width less 24px |

**Phone layout** (added 2026-10-17; `AGENT_SPEC.md` D26 revised, D44). Below 1024px
there is no beside, so the card has two forms, chosen by `phoneView` in the provider:

| Form | When | What it is |
|---|---|---|
| Full | Idle, conversing, after a proposal is answered | The card fills the window: no inset, no corners, safe-area padding. The app column under it is inert. The header carries a fold button ("Show the app") |
| Bar | A change is staged, a page was shown with `show_in_app`, or a form was handed over with Stop | The card folds to the window's foot, rounded top corners, at most 80% of the height: the header (with "Show the conversation"), the dock, and the controls. No conversation. The app column is padded by the bar's measured height (`--ast-bar`) |

- A staged form over the column becomes a **sheet**: the full width and the whole height
  above the bar, with its body scrolling. Other dialogs are unchanged.
- The lock's banner is not drawn on a phone: Stop is in the bar, under the thumb. The
  Escape hint is not shown either.
- The approval card's line F, for anything voice may approve, reads "Once you have heard
  it, say back:" (then "To approve, say back:") with the confirmation line set large in
  an assistant-tinted box, and "or press Approve. A yes alone will not do." under it.

**Zones.**

| Zone | Rules |
|---|---|
| **1 Header** | 56px. Orb, title, the status label under the title, time left, help, close |
| **2 Body** | The only zone that scrolls. Shows the conversation by default. History and help (`AGENT_GUIDE.md`) are views that replace it. Nothing else in the panel changes when the view does |
| **3 Dock** | Pinned above the controls, so it cannot scroll away. Holds the step list while working and the approval card while waiting. At most 60% of the card's height; beyond that its own content scrolls and its buttons stay fixed at its foot |
| **4 Controls** | One rounded surface: the text box, and under it a row with the voice controls on the left and End and Send on the right |

Fixing the approval card in the dock is the largest single change. It answers problem 3,
and it is what lets the help view open without hiding what is being approved.

**The body's scrollbar** is thin (6px, a `gray-300` thumb, no track) and appears on
hover and while scrolling. When the body is scrolled, its top and bottom edges fade over
16px, so text never meets a zone line abruptly.

### 8.2 The header

- **Orb and status.** The 32px orb and, under the title, the state's label from 6.1. A
  new label rises in as the old one rises out (10.3).
- **Before the conversation has started** the orb is in the body (8.3), not here, and the
  title sits at the left edge. When the orb arrives the title slides right to make room.
- **Time left.** "8 min" in `gray-500`, with a small ring that shows the share of the day
  left. Under two minutes it becomes a countdown, "1:42", in amber. At zero it is gone
  and the body explains. It is a button: pressing it shows what is left of how much, and
  when it resets in local time.
- **Help.** A question mark. Opens the help view (`AGENT_GUIDE.md` 5.3). A dot on it
  when the guide has something new.
- **History.** A clock. Shown only when no conversation is live.
- **Close.** While a conversation is live, hovering or focusing it shows "Closing ends
  the conversation".

### 8.3 The body: the conversation

**Before anything has been said (DS18).** The body is centred on the 96px orb, with its
aura, in three steps of one continuous scene:

| Step | Under the orb |
|---|---|
| Idle | The greeting and the idle content (8.9) |
| Connecting | "Connecting", then after four seconds "Waking the assistant…" |
| Listening, nothing said | **Listening** in 15px semibold, then "Say something, or type below." and the same three examples as the idle screen, quieter (`AGENT_GUIDE.md` 5.1) |

The orb stays where it is through all three; only what is under it changes. This is the
answer to problem 13: a live microphone is the largest, most alive thing on the screen.

When the first line of the conversation appears, spoken or typed, the orb travels to the
header and shrinks to 32px, and the conversation fades in (10.3).

**The conversation.**

- **The assistant's words** are plain text on the card's surface, left-aligned, full
  width. No bubble and no avatar: the orb in the header is the speaker.
- **The user's words** are a bubble on the right: `gray-100` fill, `gray-900` text, 18px
  corners with a 6px corner at the lower right, at most 85% of the width. Not blue.
  Colour in the panel is reserved for things to act on.
- **Words still arriving** are `gray-500` and settle to full strength when the line is
  final. Each new fragment fades in as it arrives (10.3). A small violet dot pulses at
  the end of the line while the assistant is speaking.
- **A turn that was cut off** by an interruption ends with a thin "—" and is not styled
  as an error.
- **The read-back turn (DS20).** The `turn_complete` frame already names the proposal a
  turn read back (`readback_for`). While that proposal is in the dock, the turn is shown
  under a small label, **Read-back**, clamped to two lines, with **Show all**. The card
  below it holds the server's own summary in full, so the same paragraph is not on
  screen twice (problem 14). This changes nothing about when the read-back counts as
  played.
- **Notices** are one centred line of 12px grey text with a small icon: "Opened
  Calendar", "Microphone paused", "Reconnected".
- **Remembered:** a one-line row with the 20px orb, the text of the memory, and **Undo**.
- **Answers with a list** (`AGENT_SPEC.md` 4.3) are a compact card of up to five rows.
  Each row is a link: a name, one line of detail, a status badge using the app's existing
  `Badge`. A last row, "Open in Supplements", when there are more.
- **Following the conversation.** The body stays scrolled to the newest line. If the
  user scrolls up, it stops following and a small **Latest** pill appears at the bottom.

### 8.4 The body: receipts and history

Every outcome leaves a receipt where it happened and it stays there (problem 7).

```
┌──────────────────────────────────────┐
│ ✓ Saved                              │
│   Site visit · Thu 15 Oct, 2:00 PM   │
│   Invites sent to 2 people      Open │
└──────────────────────────────────────┘
```

| Outcome | Look | Text |
|---|---|---|
| Committed | Green check, green left edge | "Saved", what, what was sent, **Open** |
| Failed | Red cross, red left edge | "Not saved", the reason |
| Rejected | Grey | "Not saved. You rejected it." |
| Handed over | Grey | "Stopped. The form is yours to finish." |
| Expired | Amber | "Not saved. It waited too long." |
| Replaced by a correction | No receipt | The new proposal is the outcome |

**History uses the same pieces.** A past conversation is drawn with the same turns and
the same receipts as a live one, so the two look alike.

**History rows (DS21).**

- Grouped under **Today**, **Yesterday**, then the date.
- Each row: an icon (a green check if anything was saved, a grey speech mark if not),
  the title, and one line of meta: the time, then "1 saved" as a green badge or "nothing
  saved" in grey.
- **The duration is shown only from five seconds up,** as "1 min 18 s of voice". The
  figure is metered audio time (`live_seconds`), so "0 s" on a typed or very short
  conversation was true and looked broken (problem 18). Below five seconds it is left
  out.
- A conversation with no title is "Conversation at 2:14 PM", not "Untitled". An expired
  one is "Transcript expired", as built.
- The idle screen shows the three newest and **All conversations**, which opens the
  history view. The header's clock opens the same view.

### 8.5 The dock: the step list

The dock has a one-line header whenever the app is locked:

```
◌ Working · Fill in the meeting                                Stop  Esc
```

- **Stop lives here** in the panel, and in the pill over the app (9.1), and nowhere else
  (DS19, problem 17). It is the secondary button in both, not red: Stop hands the form
  over, it does not destroy anything.
- Under the header, a vertical list with a line joining the steps.
  - Done: a small check in a grey circle, `gray-500` text. The check draws itself and
    the joining line fills downward (10.3).
  - Now: a turning arc in violet, `gray-900` text, medium weight.
- The list shows at most the last four steps. Earlier ones collapse into "2 earlier
  steps".
- The current step's text is repeated in the lock banner, so someone looking at the app
  does not have to look back at the panel.
- When a proposal arrives, the list folds into the header line: "3 steps ✓".

### 8.6 The dock: the approval card

The most important component. One card, the same structure for every kind of proposal.

```
╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮   dashed violet edge
┆ New meeting             Not saved yet  ┆   A  kind and state
┆ Site visit with Maria Lopez            ┆   B  the record, by name
┆                                        ┆
┆ When    Thu 15 Oct 2026, 2:00–2:45 PM  ┆   C  facts
┆ Where   1420 Oak Street                ┆
┆ Who     Maria Lopez                    ┆
┆         j.smith@acme.com               ┆
┆                                        ┆
┆ ⚠ j.smith@acme.com is outside the team ┆   D  exceptions
┆ ⚠ 45 minutes is from memory            ┆
┆                                        ┆
┆ “Schedule Site visit with Maria Lopez  ┆   E  the summary, word for word
┆  on Thursday 15 October at 2pm …”      ┆
├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤
┆ ✉ Sends email to 2 people.             ┆   F  how to approve
┆   Needs a click.                       ┆
┆                    Reject    Approve   ┆   G  buttons, fixed at the foot
╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯
```

| Part | Rules |
|---|---|
| **A** | An icon and the kind in plain words ("New meeting", "Change supplement details", "Archive supplement", "Send for review"). On the right, **Not saved yet** in violet |
| **B** | The record, exactly as the read-back names it |
| **C** | Two columns: a label, a value. For an edit, the old value is struck through in grey above the new one. Money and times use `tnum` |
| **D** | One row per exception, each with an amber icon. Never collapsed, never behind a "show more": these are the things `AGENT_SPEC.md` 4.4 says are always spoken |
| **E** | The server's summary, unaltered, set as a quotation in `gray-600`. It is the text the read-back is checked against (D43) and stays on the card as written |
| **F** | One line saying how this proposal can be approved, and why (below) |
| **G** | **Approve** is the app's primary blue button. **Reject** is the secondary button, not red: rejecting is the safe choice. Both are 44px tall. While the save is in flight Approve shows the existing busy spinner and both are disabled |

**Part C before the server sends facts.** Part C is drawn from `labels.facts` (section
16). Until the server sends it, the card falls back to what the proposal already
carries, in the same two-column layout: `labels.when` and `labels.attendees` for a
meeting, `labels.changes` (old struck through above new) for a details edit,
`labels.old` and `labels.new` for a memory, `labels.total` and `labels.reviewer` where
present. The browser lays these out. It never formats a date or looks a person up itself
(rule 3).

**Part F, state by state:**

| State | Icon | Text |
|---|---|---|
| Reading back | The orb, speaking | "Reading it back…" |
| Voice or click, answer window open | Microphone, with a ring emptying over the window | "Say yes, or press Approve" |
| Microphone paused (D40) | Pause | "Microphone paused." and a **Tap to talk** button |
| Click only, sends email | Envelope | "Sends email to 2 people. Needs a click." |
| Click only, changes who can edit | Padlock | "Changes who can edit. Needs a click." |
| Click only, read-back not verified (D43) | Pointer | "It did not read all of this back. Needs a click." |
| Click only, reason not sent by the server | Pointer | "Needs a click. Saying yes will not approve it." |
| Last two minutes before expiry | Clock, amber | "Expires in 1:59" |
| Reconnecting | Amber ring | "Reconnecting…" Both buttons disabled until it is back |

When a proposal is downgraded from voice to click, the line changes with a single amber
flash. Nothing else on the card moves.

**Approve is enabled the moment the card appears.** A click never depended on the
read-back (`AGENT_SPEC.md` 4.4), and the design must not suggest it does. The card's
entrance animation does not hold the buttons back (principle 9).

**Focus.** When the card appears, focus moves to its title, never to Approve: a stray
Space or Enter must not save anything. If the user is typing in the text box, focus is
left where it is and the card is announced instead.

**Release 2, room and line edits.** Part C becomes counts and a total: "3 lines added,
1 changed, 1 removed" and "$4,210.00 → $5,030.00". The lines themselves are in the
editor's diff (9.4), not listed in the card. A removed line with photos is an exception
row in part D.

### 8.7 The controls: voice

Left of the controls row, each a 40px round icon button inside a 44px touch area.

| Control | On | Off |
|---|---|---|
| Microphone | Outline button, with a violet ring that follows `--mic-level` | Filled grey, a line through the icon, "Muted" beside it |
| Speaker | Outline button | Filled grey, a line through the icon |

On the right: the word **End** in red text, as a ghost button, then Send.

- The microphone button is absent in a conversation started by typing, as built. Turning
  the microphone on part-way through such a conversation would be a new behaviour and is
  not proposed here.
- Each button has an accessible name that states what pressing it will do, and
  `aria-pressed`.
- The meter bar is removed. The ring on the microphone button and the orb both show the
  level.
- When no conversation is live the row holds only Send.

### 8.8 The controls: the text box

- One rounded surface, 16px corners, `gray-50` fill, 1px `gray-200` outline that turns
  `brand-500` when focused. The text area is inside it, above the row of buttons.
- Grows from one line to four, then scrolls. Enter sends, Shift+Enter makes a new line.
- **Send** is a 36px round button, blue when there is text and absent when there is
  none. It springs in when the first character is typed.
- The placeholder follows the state: "Type a message"; "Type a correction" while a
  proposal is waiting; "No time left today" when the allowance is used, with the box
  disabled.

### 8.9 Every state

What each zone shows in each state of `AGENT_SPEC.md` 4.1.

| State | Header status | Body | Dock | Controls |
|---|---|---|---|---|
| Idle | none; no orb in the header | The idle screen, below | — | Text box and Send |
| Allowance used | "Back at 5:00 PM" | Grey 96px orb, "You have used today's 10 minutes.", the reset time, the three newest conversations, the link to memories | — | Text box off |
| Connecting | "Connecting" | The 96px orb with its arc. If the browser is asking for the microphone: "Allow the microphone in the browser's prompt". After four seconds: "Waking the assistant…" | — | Hidden |
| Live, nothing said | "Listening" | The 96px orb, "Listening", the hint and examples (8.3) | — | All |
| Live, conversing | "Listening", "Thinking", "Speaking" or "Muted" | Conversation | — | All |
| Live, working | "Working" | Conversation | Header with Stop, step list | All |
| Awaiting approval | "Waiting for you" | Conversation | Header with Stop, approval card | All; "Type a correction" |
| Awaiting approval, paused | "Microphone paused" | Conversation | Approval card with **Tap to talk** | Microphone shown as paused |
| Allowance ran out, proposal open | "Time used" | Conversation, with a notice: "Today's time has been used. You can still approve or reject this." | Approval card, buttons enabled | Only End; text box off |
| Reconnecting | "Reconnecting… 0:42", amber | Conversation at 60% strength | As it was, buttons disabled | Only End |
| Ended | none | Conversation, then the closing card, below | — | Text box and Send |
| Viewing history | none | A list, or one conversation, read-only, with receipts inline. An expired transcript shows "Transcript expired" and its receipts | — | Text box and Send |
| Viewing help | whatever the conversation's is | The help view | As it was | As it was |

"Waking the assistant…" covers the cold start of about eight seconds that the spike
measured (`AGENT_SPEC.md` Q1). Whatever Q1 decides, the wait should have words.

**The idle screen** (problem 19), top to bottom, centred:

1. The 96px orb on its aura, drifting slowly.
2. **Hi Maria** in Sora 20px. The first name is from the user's profile, not from
   memory. With no name, "Hello".
3. One sentence in `gray-600`: "Ask about your work, or have a meeting or a supplement
   set up. Nothing is saved until you approve it."
4. **Start talking**: the primary blue button, 48px tall, full width, fully rounded,
   with a microphone icon. Under it in 12px grey: "or type below".
5. "8 of 10 minutes left today".
6. **Try saying**, with three or four examples for the page the user is on
   (`AGENT_GUIDE.md` 5.1). Until the guide is built, this block is left out; nothing
   else moves.
7. **Recent**: the three newest conversations (8.4) and **All conversations**.

On first open, the guide's introduction takes the place of items 2 to 7
(`AGENT_GUIDE.md` 5.2).

**The closing card** (DS23, problem 20), after the last line of an ended conversation:

```
┌──────────────────────────────────────┐
│ Conversation ended                   │
│ You ended it · 1 saved · 1 min 30 s  │
│                                      │
│ [   Start a new conversation   ]     │
└──────────────────────────────────────┘
```

The reason is the existing wording from `describeEnding`. The receipts above it already
say what was saved. The history list is not repeated underneath: it is behind the clock
in the header.

### 8.10 Elsewhere

**Profile → What the assistant remembers.** The card that exists, in the new language.
Each row: a category chip (Identity, Preference, Work habit), the memory, the date, and
under it in `gray-500` the words it was based on, as a quotation. A delete icon button
on the right, with the existing confirm dialog. The 20px orb beside the heading. An
empty state that says what would appear here.

**Settings → the team allowance.** The existing form field. No design change.

---

## 9. The app while the assistant works

### 9.1 The lock

- **Frame.** A 2px inset violet line around the app column, with a faint violet shade
  fading inward over about 24px. It replaces the 4px blue ring. The page is **not**
  dimmed: the user has to read what is on it.
- **Banner.** A pill on `assistant-600` with `shadow-float`: the 20px orb, **BuildCo
  Assistant is working**, the current step in lighter text, and **Stop** with "Esc"
  beside it. It sits 12px **under the app's navigation bar**, centred on the column, not
  on top of the navigation (problem 21).
- **A click on the locked app** is caught by the frame's layer. The banner answers: it
  nudges once and its step text is replaced for three seconds by "Press Stop to take
  over". Today a click does nothing at all.
- **Lock and unlock** are choreographed in 10.3.
- **Scrolling a staged form.** The column is made `inert`, and an inert scroll area may
  not respond to the wheel or to touch. If a staged dialog is taller than the window, the
  user could not read the foot of what they are approving. This has to be checked in the
  build on Chrome and on iPad Safari. If it is so, the staged dialog's body is kept
  scrollable while everything in it stays read-only.

### 9.2 A staged form

A real form, filled by the assistant, read-only, as `AGENT_SPEC.md` 6.8.

- **Banner** across the top of the dialog: `assistant-50` fill, a dashed `assistant-300`
  line under it, the 20px orb, and **Filled in by BuildCo Assistant · Not saved yet**.
- **A filled field** has a 2px violet bar on its left edge and an `assistant-50` fill.
  A field the assistant left empty looks like any empty field.
- **No placeholders (problem 15).** A staged form shows no placeholder text in any
  field. An empty field is empty. Example text in a read-only form is indistinguishable
  from a value, and what is on screen is what is approved.
- **A light scrim (problem 16).** Behind a staged dialog the scrim is 20% black in light
  mode and 35% in dark, not the 45% and 65% of an ordinary dialog. The page behind stays
  readable. An ordinary dialog is unchanged.
- **Where a value came from** is a small chip beside the field's label, drawn only when
  the server says (section 16):

  | Chip | Look |
  |---|---|
  | from memory | Violet |
  | catalogue | Grey |
  | stated by you | Grey |
  | differs from catalogue | Amber |

- **A changed value** (editing a meeting, changing details) shows the old value struck
  through in `gray-500` above the new one.
- **Arrival.** The fields' fills appear from top to bottom, 40ms apart, 400ms at most.
  Every value is in the page from the first frame; only the highlight is staggered. This
  shows the form being filled without a simulated cursor, which D17 rules out.
- **After Stop,** the banner and the marks go, the placeholders return, the form is the
  ordinary editable form with the same values, and focus moves to its first field.

### 9.3 After a save

The saved record (the meeting on the calendar, the row in the list, the header of the
supplement) gets a 1px green ring and a `success-50` tint that fades over 2.5 seconds.
The page scrolls it into view first if it is off screen.

### 9.4 The editor's diff (Release 2)

Not built in this release. Recorded here so that Release 2 builds it in this language.

| Change | Look |
|---|---|
| Line added | `assistant-50` fill, a "+" in the gutter, a dashed violet left edge |
| Field changed | The old value struck through in grey beside the new one, in the cell |
| Line removed | Struck through, `gray-500`, a "−" in the gutter. Not a red fill: it is proposed, not done |
| Line removed that has photos | As above, with an amber chip: "3 photos" |
| Room added or removed | The room's heading carries the same marks |

A bar is pinned to the foot of the editor while a diff is staged. Before Stop it reads
"Proposed by BuildCo Assistant · Not saved yet". After Stop it holds **Keep changes** and
**Discard** (`AGENT_SPEC.md` 4.5).

---

## 10. Motion

### 10.1 Tokens

| Token | Value | Used for |
|---|---|---|
| `instant` | 80ms | A press |
| `fast` | 140ms | Hover, a button's state, a label changing |
| `base` | 220ms | Things entering or leaving: a card, a bubble, a hint, a view change |
| `slow` | 320ms | The panel opening, the orb travelling |
| `slower` | 480ms | The aura, the approve moment's colour change |
| Save tint | 2,500ms, linear | 9.3 |

| Curve | Value | Feels like | Used for |
|---|---|---|---|
| `standard` | `cubic-bezier(0.2, 0, 0, 1)` | Quick, then settling | Fades, colour, small moves |
| `soft` | `cubic-bezier(0.22, 1, 0.36, 1)` | A spring with no bounce | Anything large: the panel, cards, the dock, the orb travelling |
| `pop` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | A spring that overshoots by about a tenth | Anything small: Send, a check, a chip, the launcher returning |
| `exit` | `cubic-bezier(0.4, 0, 1, 1)` | Leaving promptly | Everything going away, at `fast` |

A build may swap `soft` and `pop` for CSS `linear()` springs if they meet the same
description: no visible overshoot for `soft`, about 10% for `pop`, settled within the
token's duration.

### 10.2 Rules

- **Transform and opacity only.** Never width, height, position, a shadow, a gradient or
  a filter.
- **One exception:** small things that open and close inside the card (the folded step
  list, "Show all" on a read-back, "2 earlier steps") may animate their height with the
  grid-rows technique. They are inside a 400px card that is isolated for layout
  (`contain: layout`), so the app beside it is not reflowed.
- **The panel does not animate the app's width.** Reflowing the whole app on every frame
  is the one animation certain to stutter. The app column takes its new width in one
  step.
- **Things arrive with intent and leave quickly.** Entrances use `base` or `slow` with
  `soft`. Exits use `fast` with `exit`.
- **Lists stagger** 30 to 40ms between items, six items at most; the rest arrive
  together.
- **What may loop:** the orb while the panel is open, a progress arc, the ring that
  empties over the answer window, and the dot at the end of a line being spoken. Nothing
  else, and nothing when the tab is hidden.
- **No animation holds a control back** (principle 9). A button can be pressed from the
  first frame it is drawn.

### 10.3 Choreography

Every designed moment. "Reduced" is what happens when the user has asked for reduced
motion.

| Moment | What happens | Timing | Reduced |
|---|---|---|---|
| **Launcher wakes** | Blobs start to drift, the halo blooms to 60%, the label slides out from behind the orb | `base`, `soft` | Label appears |
| **Panel opens** | The app column takes its narrower width at once. The card grows from the launcher's corner: scale 0.92 to 1 from the lower right, 8px up, fading in. The launcher fades out under it. Then the body's contents arrive in three groups, 40ms apart, each rising 8px | Card `slow`, `soft`; contents `base` | Card appears |
| **Panel closes** | The card shrinks back to the corner and fades. When it is gone the app column widens and the launcher returns | Card `fast`, `exit`; launcher `base`, `pop` | Card disappears |
| **Start pressed** | The button presses to 97%. The greeting and idle content fade down and out. The orb stays put and takes its connecting arc. "Connecting" rises in under it | `base` | Content swaps |
| **Connected** | The arc completes and fades, the halo opens with the first microphone level, "Listening" replaces "Connecting" | `base` | Label swaps |
| **First words** | The orb travels from the centre of the body to the header and shrinks to 32px, the title slides right to make room, the listening hint fades out and the conversation fades in | `slow`, `soft` | Crossfade |
| **A user bubble** | Rises 8px, scales from 0.97, fades in, from the lower right | `base`, `soft` | Appears |
| **The assistant's words** | Each arriving fragment fades in and rises 2px. The line settles from grey to full strength when final. The final frame replaces the text without animating again | 180ms per fragment | Text appears |
| **Status label changes** | The old label rises 4px and fades; the new one rises in from 4px below | `fast` | Swaps |
| **Dock appears** | The dock rises 12px and fades in. The body above it shortens in one step and keeps the newest line in view | `base`, `soft` | Appears |
| **A step completes** | Its arc closes into a circle, the check draws itself, the joining line fills down to the next step | 240ms | Check appears |
| **Lock** | The frame fades in. One band of light travels once along its top edge. The banner drops 8px into place | Frame `base`; light 600ms; banner `base`, `soft` | Frame and banner appear |
| **A staged form fills** | The dialog scales from 0.98 and fades in. Then the fills on its fields appear top to bottom, 40ms apart | `base`; fills 400ms at most | Appears, all fields marked |
| **Approval card arrives** | The step list folds into the header. The card rises 12px and fades in. One violet ring expands from its edge and fades. Its fact rows arrive 30ms apart | `slow`, `soft`; ring 600ms | Appears |
| **Voice downgraded to click** | Part F's line flashes amber once and changes | `base` | Text changes |
| **Approve pressed** | The button presses to 97%, then shows the spinner. Both buttons are disabled | `instant` | Same |
| **Saved: the signature moment** | 1. The card's dashed violet edge crossfades to solid green. 2. "Not saved yet" becomes "Saved" and a check draws itself beside it. 3. After a short hold, the dock slides down and out. 4. A green receipt rises into the transcript. 5. In the app, the frame and banner lift and the saved record takes its green tint (9.3). Violet has become green in both places at once | 1 and 2 `slower`; hold 400ms; 3 `fast`; 4 `base`, `soft`. About 1.2s in all | Card is replaced by the receipt |
| **Not saved** | The card's edge crossfades to solid red, "Not saved" replaces "Not saved yet", then the dock leaves and a red receipt arrives. No shake | As saved | Card is replaced by the receipt |
| **Rejected, stopped, expired** | The dock slides down and out; a grey or amber receipt arrives | `fast`, then `base` | Same without movement |
| **A click on the locked app** | The banner moves 4px left, right, and back; its step text changes for three seconds | 240ms | Text changes |
| **Unlock** | The frame and the banner fade out | `fast`, `exit` | Disappear |
| **Send appears** | Scales from 0.6 with a slight overshoot when the first character is typed | `fast`, `pop` | Appears |
| **Mute, speaker** | The icon crossfades to its struck-through form; the fill fades in | `fast` | Swaps |
| **Reconnecting** | The conversation fades to 60%. The aura and the orb's ring turn amber | `slower` | Changes at once |
| **History and help views** | The outgoing view fades and moves 8px left; the incoming one comes from 8px right. Back reverses it. Rows stagger | `base` | Swap |
| **Latest pill** | Rises in from the foot of the body | `base`, `pop` | Appears |
| **First visit** | One ring expands from the launcher and fades | 900ms, once per session | Nothing |

The "Saved" sequence never blocks. The lock lifts when the server says the commit is
done, the text box and the microphone stay live throughout, and a second proposal
arriving mid-sequence cuts it short.

### 10.4 Budget

- Sixty frames a second on the oldest iPad the team uses, and in Chrome with the
  processor throttled four times. Checked by a person in D1-Human.
- No frame over 50ms is caused by an animation.
- The orb at 96px is at most seven moving layers. At 20px it has none.
- `will-change` is set only while something is animating.
- Loops stop when the tab is hidden and when the panel is closed (6.1).

### 10.5 How it is built, without a library

The app has no interface libraries: its modal, menu and toasts are written in the
repository. The assistant follows that (DS14).

| Need | How |
|---|---|
| Tokens | CSS custom properties in `styles/index.css`, beside the colour tokens |
| Entrances | CSS, with `@starting-style` so an element animates from its first frame. Where a browser lacks it the element simply appears, which is acceptable |
| Exits | A small hook in the repository, `usePresence`: it keeps a leaving element mounted, marks it as closing, and removes it when its animation ends or after the token's duration, whichever is first |
| The orb travelling, the title making room | Measure first and last positions and animate the transform between them (first, last, invert, play), with the Web Animations API |
| Levels | One animation-frame loop writing two CSS variables (6.1) |
| Drawn checks | SVG stroke dash offset |
| Reduced motion | `styles/index.css` already cuts every CSS animation and transition to nothing when the user asks. Anything driven from script checks the same setting itself: the orb, the travelling, the level loop |

---

## 11. Sound

None in this document. Short sound cues for "listening", "paused" and "saved" are a
candidate in `AGENT_FEATURES.md`, because they interact with echo cancellation and with
the timing of a spoken approval, and that makes them a behaviour, not a look.

---

## 12. Accessibility and input

- **Contrast.** Text meets 4.5 to 1 and icons and frames meet 3 to 1, in both themes.
  The table in 6.2 is checked again in the build. The aura is never behind small text.
- **Not colour alone.** DS3. Every state has a label; every receipt has a word; "not
  saved yet" is dashed and written.
- **Touch.** Every control in the panel is at least 44px in each direction. The current
  32px buttons go.
- **Keyboard.** Esc is Stop while working and closes the help or history view otherwise.
  It never closes the panel, because closing ends the conversation. Tab order follows
  the zones, top to bottom. Everything works while the app column is locked.
- **Announcements.** The transcript is already a `log`. In addition, in a polite live
  region: the status label when it changes; "App locked. Press Escape to stop." on
  entering work mode; "Waiting for your approval" with the card's title; each receipt.
  The microphone level is not announced. Text that streams in is announced once, when
  the line is final.
- **Focus.** Never moved to a button that saves. Returned to where it was when the lock
  lifts. Opening the panel moves focus to its title; closing returns it to the launcher.
- **Reduced motion.** Every row of 10.3 has a still form. The orb's states are still
  drawings. Nothing depends on having seen something move.
- **Overlay mode.** Below 1024px the card overlays the app (8.1). Nothing else changes.
- **Tablet.** The panel is used in landscape at 1024px and up. Every state is checked at
  1024 × 768, where the dock's 60% limit matters most.

---

## 13. Words in the interface

One voice, the same as `AGENT_GUIDE.md` 6.1: short, plain, the app's own names.

| Rule | Example |
|---|---|
| A state is two words at most | "Listening", "Waiting for you" |
| A refusal says what to do | "Needs a click." not "Voice approval unavailable" |
| Nothing is "saved" until a receipt says so | "Not saved yet" on everything before it |
| The assistant is "BuildCo Assistant" or "the assistant" | Never "AI", "bot" or "agent" in the interface |
| No exclamation marks, no emoji | |

---

## 14. Rules the design must not bend

From `AGENT_SPEC.md`. A build that breaks one of these is wrong however it looks.

1. A live conversation's panel is never hidden, at any window size (4.1).
2. Stop, Approve, Reject and End are always reachable and never disabled by the lock
   (4.3).
3. What is staged on the screen is exactly what will be saved. The card shows values the
   server sent, never values the browser worked out (4.4, 6.8).
4. The server's summary appears on the card word for word (4.4).
5. Every exception is visible without a click (4.4).
6. A click-only proposal must not look as though saying yes will work (D33).
7. A staged form is read-only and takes no keyboard focus (6.8).
8. No simulated cursor (D17).
9. The assistant never speaks first and nothing plays a sound on its own (A9).
10. Closing the panel ends the conversation, so nothing may close it by accident:
    not Esc, not a click outside it (D25).
11. Nothing implies a change was saved before the commit result says so (6.3). The
    green of the "Saved" moment starts on the `committed` result, never on the click.
12. No animation delays, hides or moves a control that could be pressed (principle 9).
13. When the read-back counts as played is not changed by how the transcript draws it
    (4.4, DS20).

---

## 15. Building it

### 15.1 Components

`AgentPanel.tsx` is one 450-line file today. It becomes:

| Component | Replaces |
|---|---|
| `Orb` | The microphone glyph, `MicMeter` |
| `PanelHeader` | The header block, `TimeLeft`, `Countdown` |
| `HeroState` | The idle paragraph, the "Connecting…" line, the blank live body |
| `Conversation`, `Turn`, `Notice`, `ResultList` | `Transcript`, `Remembered` |
| `Receipt` | `Outcome`, and `PastAction` in `AgentHistory.tsx` |
| `Dock`, `DockHeader`, `StepList` | The working banner, the `<ol>` of steps |
| `ApprovalCard` | `ApprovalCard`, rebuilt to 8.6 |
| `Controls`, `IconButton` | The footer's buttons, `Composer` |
| `IdleView`, `EndedCard` | The inline blocks for those phases |
| `HistoryView` | `AgentHistory`, restyled to 8.4 |
| `LockFrame`, `LockBanner` | The lock markup in `AppFrame.tsx`, `AgentLockBanner` |
| `StagedBanner`, `SourceChip`, staged field styling | The staged strip in `Modal.tsx` |
| `icons.tsx` | A small set of inline SVG icons on a 20px grid with a 1.6px stroke, matching the icons already in `AppShell` and `Modal` |
| `motion.ts`, `usePresence`, `levels.ts` | New (10.5, 6.1) |

Other files touched:

| File | Change |
|---|---|
| `styles/index.css` | The `assistant` ramp in both themes, the two shadows, the motion tokens |
| `components/AppFrame.tsx` | The card's geometry, the lock frame, where the banner sits, toasts while a panel is open |
| `components/AppShell.tsx` | Bottom padding on the main area while the launcher shows |
| `components/Modal.tsx` | The staged banner, the light scrim, no placeholders while staged |
| `MeetingModal.tsx`, `NewEstimateModal.tsx`, `SubmitForReviewModal.tsx`, `EstimateEditorPage.tsx` | Marks on filled fields |
| `features/agent/audio.ts` | The playback worklet reports its level |
| `features/agent/AgentProvider.tsx` | Levels leave React state |
| `features/agent/agentState.ts` | Below |
| `features/agent/AgentMemories.tsx` | 8.10 |

**The reducer keeps its shape,** with three additions and nothing removed from what a
page reads:

- Receipts are kept as a list in the transcript's order, in place of the single
  `lastResult`. Pages that read `commits` and the last target are unaffected.
- An assistant line can carry the id of the proposal it read back, set from
  `turn_complete.readback_for`.
- Levels are not in it.

No behaviour moves. What frames are sent and when is unchanged.

### 15.2 A gallery of states

A development-only route, `/dev/assistant`, that draws the card in every state of 8.9
from fixed reducer states, side by side, in light and dark. The reducer is pure, so each
state is a fixture.

- **It is built first, and it is the review surface** (DS15). It is how a person judges
  the design in the real app without holding a conversation.
- It includes the approval card in every state of part F, each receipt, the lock with a
  staged form, and a control to replay each row of 10.3.
- It is where reduced motion, 1024 × 768 and dark mode are checked.
- It is excluded from the production build.

There is a precedent: `AGENT_SPEC.md` section 9 planned a development-only stand-in for
the panel in preparatory change B.

### 15.3 Tests

- Each state in the gallery renders and has its status label.
- A live conversation with an empty transcript shows "Listening" and the hint, not an
  empty body.
- The header has no orb while the large one is showing, and has one after the first
  line.
- With a proposal open: the card is in the dock, Approve is enabled on first render, and
  focus is not on it.
- A click-only proposal shows the line for its reason and never "Say yes". With no
  reason sent, it shows the neutral line.
- With no `labels.facts`, part C is drawn from the existing labels.
- The exceptions are all in the document without interaction.
- Receipts accumulate: three commits show three receipts.
- The read-back turn is clamped while its proposal is open, and `readback_played` is
  sent exactly when it was before.
- Stop appears once in the panel and once over the app while locked.
- A staged `MeetingModal` and a staged `NewEstimateModal` render no placeholder; after
  Stop the placeholders are back.
- A history row with zero seconds shows no duration.
- The launcher is at the bottom right; it is not offered under 1024px; a live panel is
  never hidden.
- With reduced motion requested, the orb renders its still form and the first line
  appears without the orb travelling.
- The level updates do not re-render the panel (a render counter in the test).
- Every icon button has an accessible name.
- The existing suites pass unchanged where behaviour is concerned: `agentState.test.ts`,
  `AgentProvider.test.tsx`, `Modal.test.tsx`, `AppShell.test.tsx`.

---

## 16. What the design needs from the server

Three small things. **The build does not wait for the first two:** the card has a stated
fallback for each (8.6), so the frontend can land first and improve when they arrive.

| Need | Why | Change | Until then |
|---|---|---|---|
| `labels.facts` on the `proposal` frame: an ordered list of `{label, value, was?, source?}` | Part C of the card, and the source chips on a staged form. The browser must not format dates or look people up itself (rule 3) | The summary builders in `agent_rules.py` already have every value; they return them as a list as well as a sentence | Part C from the existing labels; no source chips |
| `approval_reason` on the `proposal` frame | Part F. Shared with `AGENT_GUIDE.md` 8.4 | `sends_email`, `changes_access` or `readback_unverified` | The neutral line |
| The playback worklet reports its level | The orb while speaking | Browser only. No server change | — |

---

## 17. Delivery plan

### Ownership

| Phase | What | Owner |
|---|---|---|
| D0-Human | Read this document. Settle DQ2 to DQ6. Sign it off, or say what to change | Human |
| D1-Claude | Everything in sections 6 to 10, 12, 15 and 16, in one pass, in the order of section 21 | Claude |
| D1-Human | Walk the gallery. Hold a real conversation on a laptop and on an iPad, in light and dark, and once with reduced motion on. Review, commit, release | Human |
| D2-Claude | The editor's diff (9.4). Only when Release 2 is being built | Claude |
| D2-Human | Review with Release 2 | Human |

There is no mock phase. "Modern and sleek" is a judgement, and the gallery lets it be
made on the real thing, in the real app, in both themes.

### When

Now. Release 1 is finished, so nothing else is working in `src/features/agent/`.

**Before Release 2.** Release 2's editor diff is the most intricate screen in the whole
project (`AGENT_SPEC.md` section 11). With the design in first, the diff is built once,
in this language.

**Before the guide** (`AGENT_GUIDE.md`), so that the guide's components are built in the
new look and not restyled a week later. The idle screen leaves the guide's two places
empty until then (8.9).

---

## 18. Out of scope

| Excluded | Why |
|---|---|
| Any change to what the assistant can do, say or save | This is the look only |
| Redesigning the rest of the app | This is the assistant only. The top bar, tables and forms are untouched, apart from the bottom padding in section 7 and staged dialogs in 9.2 |
| Sound | Section 11 |
| A resizable or detachable panel | A behaviour. `AGENT_FEATURES.md` if it is wanted |
| A phone layout | D26 |
| A choice of themes or accent colours | One look |
| Glass, blurred backdrops, animated backgrounds | Principle 7. Considered and declined in favour of "expressive but calm" |
| Illustrations, mascots, an animated character | The orb is the whole of the assistant's character |
| An animation library | DS14, 10.5 |
| Keyboard shortcuts beyond Esc and Enter | `AGENT_FEATURES.md` |
| Better history titles written by the server | Needs the server. 8.4 does what the browser can |

---

## 19. Assumptions and open questions

### Defaults chosen without asking

| # | Assumption |
|---|---|
| DA1 | The card is 400px wide and takes 424px of the window |
| DA2 | The header is 56px. It no longer lines up with the app's top bar, because the card floats |
| DA3 | The assistant's turns have no bubble and no avatar |
| DA4 | Reject is not red, and neither is Stop |
| DA5 | The step list shows the last four steps |
| DA6 | The dock is limited to 60% of the card's height |
| DA7 | The launcher is 56px, and the page gains 88px of bottom padding to clear it |
| DA8 | Icons are drawn in the repository, not taken from an icon package |
| DA9 | The greeting is "Hi" and the first word of the profile's full name |
| DA10 | A history duration under five seconds is not shown |
| DA11 | A staged dialog's scrim is 20% black in light mode and 35% in dark |
| DA12 | The lock banner sits under the navigation bar, not over it |

### Settled

| # | Question | Answer |
|---|---|---|
| DQ1 | The accent | Violet, blending from brand blue (2026-10-11) |

### Open, for sign-off

Each has a default, which is what gets built if nothing is said.

| # | Question | Default |
|---|---|---|
| DQ2 | **The user's bubbles.** Neutral grey, or brand blue as built | Grey |
| DQ3 | **The orb.** Whether a state-showing orb is the right face, or the company wants something drawn | The orb |
| DQ4 | **How much the idle screen says.** A greeting, examples and recent conversations, or only the Start button and the text box | All of it |
| DQ5 | **The read-back turn clamped to two lines** while its card is open (DS20). The alternative is to leave it in full and accept the repetition | Clamped |
| DQ6 | **The launcher's corner label.** "Ask BuildCo Assistant", as now, or something shorter | As now |

---

## 20. Where this touches `AGENT_SPEC.md`

`AGENT_SPEC.md` is not rewritten. Its companion-documents section points here for each
of these, and this document governs how they look.

| Section | What this document changes |
|---|---|
| D15, 1, 4.1 | The launcher is bottom-right and its label is part of the button, not a tooltip. The time-used launcher shows the reset time (7) |
| 4.1 | The panel is a floating card with four zones. The approval card and step list are pinned in the dock. The header shows the status and the time left. "Waking the assistant…" is added to *Connecting*. A live conversation with nothing said has its own screen (8) |
| 4.3 | The frame is violet and 2px; the banner sits under the navigation and names the current step; a click on the locked app is answered. The scrolling check of 9.1 belongs here |
| 4.3 | "The change highlighted for a few seconds" is the green tint of 9.3 |
| 4.4 | The card's structure (8.6). Approve is enabled from the moment the card appears. Focus never lands on Approve |
| 4.8 | Receipts in a live conversation match the action cards in history. A duration under five seconds is not shown |
| 6.7 | `labels.facts` and `approval_reason` on `proposal` (16) |
| 6.8 | The component list of 15.1; levels are not React state; the gallery route; a staged dialog shows no placeholders and has a light scrim |
| 8 | The tests of 15.3 |
| 9 | Phases D0 to D2 |
| 12 | A10 (hover text) is superseded by section 7. DA1 to DA12 are added |

---

## 21. Handing this to an implementer

Everything a session needs to build D1 without this conversation.

**Read first.** This document. Then `AGENT_SPEC.md` 4.1 to 4.5, 6.7 and 6.8 for the
behaviour that must not move. Then the code: `features/agent/AgentPanel.tsx`,
`AgentLauncher.tsx`, `AgentHistory.tsx`, `agentState.ts`, `AgentProvider.tsx`,
`audio.ts`, and `components/AppFrame.tsx`, `Modal.tsx`, `styles/index.css`.

**Do not change:** what any frame means or when it is sent; when the app locks and
unlocks; when `readback_played` is sent; what Approve, Reject, Stop and End do; anything
on the server beyond section 16.

**Order.**

1. Tokens: the `assistant` ramp in both themes, the shadows, the motion tokens.
2. `icons.tsx`, `usePresence`, `levels.ts`, and the playback level in `audio.ts`.
3. The orb, in every state and size, with its still forms.
4. The gallery route, showing the orb. Every later step adds its states to it.
5. The card and the launcher in `AppFrame.tsx`: geometry, overlay mode, open and close.
6. The header, the large-orb states, the idle screen, the travelling orb.
7. The conversation: turns, streaming words, notices, Remembered, the Latest pill.
8. Receipts, in the reducer and on screen. History in the same pieces.
9. The dock: its header with Stop, the step list, the approval card with part F in every
   state, and the "Saved" moment.
10. The controls.
11. The lock frame and banner; staged dialogs: banner, scrim, placeholders, field marks.
12. The ended card, the allowance states, reconnecting.
13. The memories card on Profile.
14. The two server fields of section 16 and their use, if the server is in scope for the
    session; otherwise the fallbacks stand.
15. Tests of 15.3. The existing suites still pass.

**Done when.**

- The gallery shows every state of 8.9 and every row of 10.3, in light and dark.
- Every problem in section 3 is answered on screen.
- Every rule in section 14 holds, and each has a test where a test can check it.
- `npm run typecheck`, `npm run lint` and `npm test` pass in `apps/staff-web`.
- No dependency was added.
- The work is left uncommitted on its own branch off `feature/assistant-release-1`, with
  a short report: what was built, what was not, and any decision taken along the way.
