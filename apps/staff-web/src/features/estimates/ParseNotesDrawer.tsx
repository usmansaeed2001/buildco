/**
 * Free-form site notes in, a draft estimate out.
 *
 * Two decisions worth stating, both departures from the legacy drawer:
 *
 * **The parse is previewed, not applied.** `runParse` in `app.html` loaded the model's
 * output straight into the editor, replacing whatever was there. Someone who had spent
 * ten minutes pricing a room and then tried the parser lost it. Here the result is
 * shown first, with its total, and the user chooses to append or replace.
 *
 * **Appending is the default.** Replacing is offered, behind its own confirmation, but
 * the common case is dictating one room at a time as you walk a property.
 *
 * Applying is an undo step in the editor's history, not a save — so it can be taken
 * back with the same Undo button as everything else.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/api/client";
import { useParseNotes } from "@/api/queries/ai";
import type { ParsedEstimate } from "@/api/types";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Modal } from "@/components/Modal";
import { Alert } from "@/components/feedback";
import { Field, Textarea } from "@/components/form";
import { computeTotals } from "@/domain/estimateTotals";
import { formatMoney } from "@/domain/money";
import { cn } from "@/lib/cn";
import {
  isSpeechSupported,
  startDictation,
  SPEECH_LANGUAGES,
  type Dictation,
  type SpeechLanguage,
} from "@/lib/speech";
import { readRooms, type RoomDoc } from "./document";

export function ParseNotesDrawer({
  open,
  onClose,
  onApply,
  hasExistingRooms,
}: {
  open: boolean;
  onClose: () => void;
  /** `replace` discards the current document; otherwise the rooms are appended. */
  onApply: (rooms: RoomDoc[], mode: "append" | "replace") => void;
  hasExistingRooms: boolean;
}) {
  const parse = useParseNotes();

  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState<ParsedEstimate | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const [language, setLanguage] = useState<SpeechLanguage>("en-US");
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const dictation = useRef<Dictation | null>(null);

  const speechAvailable = isSpeechSupported();

  // Stop the microphone if the drawer closes or the component goes away. A recogniser
  // left running holds the mic indicator on and keeps transcribing into nothing.
  useEffect(() => {
    if (!open && dictation.current) {
      dictation.current.stop();
      dictation.current = null;
      setListening(false);
      setInterim("");
    }
  }, [open]);

  useEffect(() => {
    return () => {
      dictation.current?.stop();
      dictation.current = null;
    };
  }, []);

  function toggleMic() {
    if (listening) {
      dictation.current?.stop();
      return;
    }

    setFailure(null);
    dictation.current = startDictation(language, {
      onPhrase: (phrase) =>
        // Appended to whatever is in the box now, including anything typed while
        // dictating. The legacy version rebuilt the value from a stale closure and
        // duplicated or clipped text as a result.
        setNotes((current) => (current ? `${current.trimEnd()} ${phrase}` : phrase)),
      onInterim: setInterim,
      onError: setFailure,
      onEnd: () => {
        setListening(false);
        setInterim("");
        dictation.current = null;
      },
    });

    if (dictation.current) setListening(true);
  }

  function changeLanguage(next: SpeechLanguage) {
    // The language is fixed when the session starts, so switching mid-session would
    // silently keep recognising the old one.
    if (listening) dictation.current?.stop();
    setLanguage(next);
  }

  async function run() {
    setFailure(null);
    setDraft(null);
    if (listening) dictation.current?.stop();

    try {
      setDraft(await parse.mutateAsync(notes));
    } catch (caught) {
      setFailure(describe(caught));
    }
  }

  function apply(mode: "append" | "replace") {
    if (!draft) return;
    onApply(readRooms(draft.rooms), mode);
    reset();
    onClose();
  }

  function reset() {
    setNotes("");
    setDraft(null);
    setFailure(null);
    setInterim("");
    setConfirmReplace(false);
  }

  const draftRooms = draft ? readRooms(draft.rooms) : [];
  const draftTotals = computeTotals(draftRooms);

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Parse notes into an estimate"
        description="Describe the work in plain language. Rooms and line items are extracted for you to review."
        size="xl"
        footer={
          draft ? (
            <>
              <Button onClick={() => setDraft(null)}>Back to notes</Button>
              {hasExistingRooms && (
                <Button variant="danger" onClick={() => setConfirmReplace(true)}>
                  Replace everything
                </Button>
              )}
              <Button variant="primary" onClick={() => apply("append")}>
                {hasExistingRooms ? "Add to this estimate" : "Use these rooms"}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onClose}>Cancel</Button>
              <Button
                variant="primary"
                busy={parse.isPending}
                disabled={notes.trim().length === 0}
                onClick={() => void run()}
              >
                Parse notes
              </Button>
            </>
          )
        }
      >
        {failure && (
          <div className="mb-4">
            <Alert tone="danger">{failure}</Alert>
          </div>
        )}

        {draft ? (
          <DraftPreview rooms={draftRooms} total={formatMoney(draftTotals.total)} />
        ) : (
          <div className="flex flex-col gap-3">
            <Field
              label="Site notes"
              hint="For example: “Kitchen — 200 square feet of drywall at 2.50, two coats of paint. Hallway — 30 feet of baseboard.”"
            >
              {(props) => (
                <Textarea
                  {...props}
                  rows={10}
                  value={notes}
                  placeholder="Describe the work…"
                  onChange={(event) => setNotes(event.target.value)}
                />
              )}
            </Field>

            {speechAvailable ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={listening ? "danger" : "secondary"}
                  size="sm"
                  onClick={toggleMic}
                  aria-pressed={listening}
                >
                  {listening ? "Stop dictating" : "Dictate"}
                </Button>

                <div className="flex gap-1" role="group" aria-label="Dictation language">
                  {SPEECH_LANGUAGES.map((option) => (
                    <button
                      key={option.code}
                      type="button"
                      aria-pressed={language === option.code}
                      onClick={() => changeLanguage(option.code)}
                      className={cn(
                        "rounded px-2 py-1 text-xs font-medium",
                        language === option.code
                          ? "bg-gray-900 text-white"
                          : "bg-white text-gray-600 ring-1 ring-inset ring-gray-300 hover:bg-gray-50",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                {listening && (
                  <p role="status" className="text-sm text-gray-500">
                    {interim ? `Hearing: ${interim}` : "Listening… speak your notes"}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-gray-500">
                Dictation needs Chrome or Edge. You can still type or paste notes here.
              </p>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmReplace}
        title="Replace the whole estimate?"
        confirmLabel="Replace everything"
        onCancel={() => setConfirmReplace(false)}
        onConfirm={() => apply("replace")}
      >
        <p>
          Every existing room and line item will be removed and replaced with the{" "}
          {draftRooms.length} {draftRooms.length === 1 ? "room" : "rooms"} above.
        </p>
        <p className="mt-2">You can undo this.</p>
      </ConfirmDialog>
    </>
  );
}

function DraftPreview({ rooms, total }: { rooms: RoomDoc[]; total: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-gray-600">
          {rooms.length} {rooms.length === 1 ? "room" : "rooms"} found. Review before adding.
        </p>
        <output aria-label="Draft total" className="tnum text-lg font-semibold text-gray-900">
          {total}
        </output>
      </div>

      <ul className="flex flex-col gap-3">
        {rooms.map((room, index) => (
          <li key={index} className="rounded-card ring-1 ring-gray-200">
            <p className="border-b border-gray-100 px-3 py-2 text-sm font-medium text-gray-900">
              {room.name}
            </p>
            <ul className="divide-y divide-gray-100">
              {room.items.map((item, itemIndex) => (
                <li
                  key={itemIndex}
                  className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate text-gray-800">{item.name}</span>
                  <span className="tnum shrink-0 text-gray-500">
                    {item.quantity} {item.unit} &times; {formatMoney(item.unitCost)}
                  </span>
                </li>
              ))}
              {room.items.length === 0 && (
                <li className="px-3 py-1.5 text-sm text-gray-400">No line items</li>
              )}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isIntegrationUnavailable) {
      return "The note parser is not configured on this environment, so notes cannot be parsed automatically. You can still add rooms and items by hand.";
    }
    if (error.status === 422) {
      return "No rooms could be found in those notes. Try naming each room and what was done in it — for example “Kitchen — 200 square feet of drywall”.";
    }
    return error.message;
  }
  return "The notes could not be parsed. Please try again.";
}
