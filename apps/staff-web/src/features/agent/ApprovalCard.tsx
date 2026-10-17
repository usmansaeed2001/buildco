/**
 * The approval card: what is about to be saved, and how to say yes or no.
 *
 * The most important component in the panel. It is one card with the same structure for
 * every kind of proposal, so the eye learns where to look:
 *
 *   A  what kind of change, and that it is not saved yet
 *   B  the record, by name
 *   C  the facts, as labels and values, checkable in one pass
 *   D  every exception, never collapsed
 *   E  the server's summary, word for word
 *   F  how this one can be approved, and why
 *   G  Reject and Approve
 *
 * Rules it must not bend (`AGENT_DESIGN.md` 14):
 *
 * - **It shows what the server sent, never what the browser worked out.** No date is
 *   formatted here and nobody is looked up. Part C is laid out from `labels.facts`, and
 *   until the server sends that, from the labels the proposal already carries.
 * - **The summary is the server's text, unaltered.** It is what the read-back is checked
 *   against.
 * - **A click-only proposal never looks as though saying yes will work.**
 * - **Approve can be pressed from the first frame.** A click never depended on the
 *   read-back, and nothing here suggests it does. And focus never lands on it: a stray
 *   Space or Enter must not save anything.
 * - **Nothing is green until the commit result says so.** `settled` is set from that
 *   result and from nothing else.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/Button";
import { cn } from "@/lib/cn";
import {
  BookmarkIcon,
  CalendarIcon,
  ClockIcon,
  DocumentIcon,
  DrawnCheck,
  MailIcon,
  MicIcon,
  PadlockIcon,
  PauseIcon,
  PointerIcon,
  WarningIcon,
} from "./icons";
import { kindTitle } from "./kinds";
import { Orb } from "./Orb";
import { clock } from "./presence";
import type { Proposal, ProposalFact } from "./protocol";

/** How long a click is shown as on its way before the buttons come back regardless. */
const IN_FLIGHT_MS = 10_000;
/** The last stretch before a proposal expires, when the card says so. */
const EXPIRY_WARNING_S = 120;
/** The length of the ring drawn round the microphone while an answer is awaited. */
const WINDOW_RING = 2 * Math.PI * 8;

const SOURCES: Record<string, { label: string; look: string }> = {
  memory: {
    label: "from memory",
    look: "bg-assistant-50 text-assistant-700 ring-assistant-100 dark:text-assistant-300",
  },
  catalogue: { label: "catalogue", look: "bg-gray-100 text-gray-600 ring-gray-200" },
  stated: { label: "stated by you", look: "bg-gray-100 text-gray-600 ring-gray-200" },
  differs: {
    label: "differs from catalogue",
    look: "bg-warning-100 text-warning-600 ring-warning-500/20 dark:text-warning-400",
  },
};

/** Where a value came from. Drawn only when the server says. */
export function SourceChip({ source }: { source: string }) {
  const known = SOURCES[source];
  if (!known) return null;
  return (
    <span
      className={cn(
        "ml-1.5 inline-flex items-center rounded-full px-1.5 py-px text-[11px] font-medium whitespace-nowrap ring-1 ring-inset",
        known.look,
      )}
    >
      {known.label}
    </span>
  );
}

/**
 * Part C. From `labels.facts` when the server sends it. Until then, from what the
 * proposal already carries, in the same two columns: laid out here, never worked out.
 */
function factsOf(proposal: Proposal): ProposalFact[] {
  const { labels } = proposal;
  if (labels.facts && labels.facts.length > 0) return labels.facts;

  const facts: ProposalFact[] = [];
  if (labels.when) facts.push({ label: "When", value: labels.when });
  const people = (labels.attendees ?? []).map((person) =>
    person.note ? `${person.label} (${person.note})` : person.label,
  );
  if (people.length > 0) facts.push({ label: "Who", value: people.join("\n") });
  for (const change of labels.changes ?? []) {
    facts.push({ label: change.label, value: change.new || "blank", was: change.old || "blank" });
  }
  if (proposal.kind === "memory.change") {
    facts.push({
      label: "Memory",
      value: labels.new ?? "Forgotten",
      ...(labels.old ? { was: labels.old } : {}),
    });
  }
  if (labels.total) facts.push({ label: "Total", value: labels.total });
  if (labels.reviewer) {
    facts.push({ label: "Reviewer", value: `${labels.reviewer.name}\n${labels.reviewer.email}` });
  }
  return facts;
}

function recordOf(proposal: Proposal): string | null {
  const named = [
    proposal.labels.name,
    proposal.payload["title"],
    proposal.payload["project_name"],
  ].find((value): value is string => typeof value === "string" && value.trim() !== "");
  return named ?? null;
}

function KindIcon({ kind }: { kind: string }) {
  const className = "size-[18px] text-gray-500";
  if (kind.startsWith("meeting.")) return <CalendarIcon className={className} />;
  if (kind === "memory.change") return <BookmarkIcon className={className} />;
  if (kind === "supplement.submit") return <MailIcon className={className} />;
  return <DocumentIcon className={className} />;
}

/** Seconds until the proposal expires, once that is close. Null until then. */
function useExpiry(expiresAt: string, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const at = new Date(expiresAt).getTime();
  if (!active || Number.isNaN(at)) return null;
  const left = (at - now) / 1000;
  return left > 0 && left <= EXPIRY_WARNING_S ? left : null;
}

export interface ApprovalCardProps {
  proposal: Proposal;
  /** Over a dead connection nothing can be approved. The card stays; its buttons wait. */
  reconnecting?: boolean;
  /** Why the microphone is off although the conversation is live, if it is. */
  paused?: "approval" | "allowance" | null;
  /** The assistant's voice is playing. */
  speaking?: boolean;
  /** This proposal's read-back has finished playing, so a spoken yes can count. */
  readbackPlayed?: boolean;
  /**
   * Laid out for a phone. There a yes does not approve: the user says the proposal's
   * confirmation line back, and the card shows that line.
   */
  phone?: boolean;
  /**
   * What became of it, from the commit result. Shown on the card for a moment before it
   * leaves: violet becomes green, or red.
   */
  settled?: "saved" | "failed" | null;
  onApprove: () => void;
  onReject: () => void;
  /** Tap to talk. */
  onResume: () => void;
}

export function ApprovalCard({
  proposal,
  reconnecting = false,
  paused = null,
  speaking = false,
  readbackPlayed = false,
  phone = false,
  settled = null,
  onApprove,
  onReject,
  onResume,
}: ApprovalCardProps) {
  const title = useRef<HTMLHeadingElement>(null);
  const facts = factsOf(proposal);
  const record = recordOf(proposal);
  const expiresIn = useExpiry(proposal.expires_at, settled === null);

  // Focus goes to the title, never to a button that saves. Someone typing a correction
  // is left where they are; the card is announced to them instead.
  useEffect(() => {
    const focused = document.activeElement;
    const typing =
      focused instanceof HTMLElement && (focused.tagName === "TEXTAREA" || focused.tagName === "INPUT");
    if (!typing) title.current?.focus({ preventScroll: true });
  }, [proposal.id]);

  // A click on its way. The server answers with the outcome, which takes the card away;
  // if it answers with anything else, or with nothing, the buttons come back.
  const [sent, setSent] = useState<string | null>(null);
  const inFlight = sent === `${proposal.id}:${proposal.approval}`;
  useEffect(() => {
    if (!inFlight) return;
    const timer = window.setTimeout(() => setSent(null), IN_FLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [inFlight]);

  // A voice approval that became a click says so once.
  const approvalWas = useRef({ id: proposal.id, approval: proposal.approval });
  const downgraded =
    approvalWas.current.id === proposal.id &&
    approvalWas.current.approval === "voice_or_click" &&
    proposal.approval === "click";
  const [flashed, setFlashed] = useState<string | null>(null);
  if (downgraded && flashed !== proposal.id) setFlashed(proposal.id);
  useEffect(() => {
    approvalWas.current = { id: proposal.id, approval: proposal.approval };
  }, [proposal.id, proposal.approval]);

  const disabled = reconnecting || inFlight || settled !== null;

  return (
    <section
      aria-label="Waiting for your approval"
      {...(settled ? { "data-settled": settled } : {})}
      className="ast-approval flex min-h-0 flex-col rounded-card bg-surface"
    >
      <span className="ast-edge ast-edge-pending" />
      <span className="ast-edge ast-edge-saved" />
      <span className="ast-edge ast-edge-failed" />
      <span className="ast-approval-ring" />

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
        {/* A: the kind, and its state. */}
        <div className="flex items-center gap-2">
          <KindIcon kind={proposal.kind} />
          <h3
            ref={title}
            tabIndex={-1}
            className="min-w-0 flex-1 truncate font-sans text-sm font-semibold text-gray-900 outline-none"
          >
            {kindTitle(proposal.kind, proposal.labels.action_label)}
          </h3>
          {settled === "saved" ? (
            <span className="flex items-center gap-1 text-xs font-semibold text-success-700 dark:text-success-400">
              <DrawnCheck className="size-4" />
              Saved
            </span>
          ) : settled === "failed" ? (
            <span className="text-xs font-semibold text-danger-600 dark:text-danger-400">
              Not saved
            </span>
          ) : (
            <span className="text-xs font-semibold text-assistant-700 dark:text-assistant-300">
              Not saved yet
            </span>
          )}
        </div>

        {/* B: the record, exactly as it is named aloud. */}
        {record && <p className="-mt-1.5 text-sm font-medium text-gray-900">{record}</p>}

        {/* C: the facts. */}
        {facts.length > 0 && (
          <dl className="ast-facts grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm leading-5">
            {facts.map((fact) => (
              <div key={fact.label} className="contents">
                <dt className="text-gray-500">
                  {fact.label}
                  {fact.source && <SourceChip source={fact.source} />}
                </dt>
                <dd className="tnum min-w-0 whitespace-pre-wrap text-gray-900">
                  {fact.was !== undefined && (
                    <span className="block text-gray-500 line-through">
                      <span className="sr-only">Now: </span>
                      {fact.was}
                    </span>
                  )}
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {/* D: every exception, always in view. These are what is always spoken. */}
        {proposal.warnings.length > 0 && (
          <ul aria-label="Check before approving" className="flex flex-col gap-1.5">
            {proposal.warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-2 text-sm leading-5 text-gray-900">
                <WarningIcon className="mt-px size-[18px] text-warning-600 dark:text-warning-400" />
                {warning}
              </li>
            ))}
          </ul>
        )}

        {/* E: the summary, as the server wrote it. The quotation marks are drawn by the
            stylesheet, so the text in the page is the server's and nothing else. */}
        <blockquote className="border-l-2 border-gray-200 pl-2.5 text-sm leading-5 text-gray-600">
          <p className="before:content-['“'] after:content-['”']">{proposal.summary}</p>
        </blockquote>
      </div>

      <div className="flex flex-col gap-2.5 border-t border-dashed border-assistant-300 p-3">
        {/* F: how this one can be approved, and why. */}
        <div className="flex min-h-5 items-center justify-between gap-3 text-xs leading-4">
          <HowToApprove
            key={flashed === proposal.id ? "flashed" : "plain"}
            proposal={proposal}
            reconnecting={reconnecting}
            paused={paused}
            speaking={speaking}
            readbackPlayed={readbackPlayed}
            phone={phone}
            flash={flashed === proposal.id}
            onResume={onResume}
          />
          {expiresIn !== null && (
            <span
              role="timer"
              aria-label="Time left to approve"
              className="tnum flex shrink-0 items-center gap-1 font-medium text-warning-600 dark:text-warning-400"
            >
              <ClockIcon className="size-4" />
              Expires in {clock(expiresIn)}
            </span>
          )}
        </div>

        {/* G: the buttons. Reject is not red: rejecting is the safe choice. */}
        <div className="flex justify-end gap-2">
          <Button className="ast-press h-11! px-5!" onClick={onReject} disabled={disabled}>
            Reject
          </Button>
          <Button
            variant="primary"
            className="ast-press h-11! px-5!"
            busy={inFlight}
            disabled={disabled}
            onClick={() => {
              setSent(`${proposal.id}:${proposal.approval}`);
              onApprove();
            }}
          >
            Approve
          </Button>
        </div>
      </div>
    </section>
  );
}

function Line({
  icon,
  flash = false,
  amber = false,
  children,
}: {
  icon: ReactNode;
  flash?: boolean;
  amber?: boolean;
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "flex min-w-0 items-center gap-1.5",
        amber ? "text-warning-600 dark:text-warning-400" : "text-gray-600",
        flash && "ast-flash",
      )}
    >
      {icon}
      <span>{children}</span>
    </p>
  );
}

function HowToApprove({
  proposal,
  reconnecting,
  paused,
  speaking,
  readbackPlayed,
  phone,
  flash,
  onResume,
}: {
  proposal: Proposal;
  reconnecting: boolean;
  paused: "approval" | "allowance" | null;
  speaking: boolean;
  readbackPlayed: boolean;
  phone: boolean;
  flash: boolean;
  onResume: () => void;
}) {
  const small = "size-4";

  if (reconnecting) {
    return (
      <Line amber icon={<Orb size={20} state="reconnecting" />}>
        Reconnecting…
      </Line>
    );
  }

  // Tap to talk is offered whatever kind of approval this is: a click-only proposal can
  // still be corrected by voice.
  const withTapToTalk = (line: ReactNode) =>
    paused !== "approval" ? (
      line
    ) : (
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
        {line}
        <Button size="sm" className="ast-press h-11! shrink-0 px-4!" onClick={onResume}>
          Tap to talk
        </Button>
      </div>
    );

  // The audio has stopped for good today, so a yes cannot be heard whatever the policy.
  const clickOnly = proposal.approval === "click" || paused === "allowance";
  if (clickOnly) {
    const reason = proposal.approval === "click" ? proposal.approval_reason : undefined;
    if (reason === "sends_email") {
      return withTapToTalk(
        <Line flash={flash} icon={<MailIcon className={small} />}>
          Sends email. Needs a click.
        </Line>,
      );
    }
    if (reason === "changes_access") {
      return withTapToTalk(
        <Line flash={flash} icon={<PadlockIcon className={small} />}>
          Changes who can edit. Needs a click.
        </Line>,
      );
    }
    if (reason === "readback_unverified") {
      return withTapToTalk(
        <Line flash={flash} icon={<PointerIcon className={small} />}>
          It did not read all of this back. Needs a click.
        </Line>,
      );
    }
    return withTapToTalk(
      <Line flash={flash} icon={<PointerIcon className={small} />}>
        Needs a click. Saying yes will not approve it.
      </Line>,
    );
  }

  if (paused === "approval") {
    return withTapToTalk(<Line icon={<PauseIcon className={small} />}>Microphone paused.</Line>);
  }

  const confirm = proposal.labels.confirm?.line;
  if (phone && !speaking) {
    // The words to say are the point of this line, so they are the largest thing in it.
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <Line icon={<MicIcon className={small} />}>
          {!confirm
            ? "Press Approve when you are ready"
            : readbackPlayed
              ? "To approve, say back:"
              : "Once you have heard it, say back:"}
        </Line>
        {confirm && (
          <p
            data-confirm-line
            className="rounded-md bg-assistant-50 px-2 py-1.5 text-sm leading-5 font-medium text-gray-900"
          >
            &ldquo;{confirm}&rdquo;
          </p>
        )}
        {confirm && <span className="text-gray-500">or press Approve. A yes alone will not do.</span>}
      </div>
    );
  }

  if (readbackPlayed) {
    return (
      <Line
        icon={
          <span className="relative grid size-5 place-items-center">
            <MicIcon className="size-3.5" />
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
              className="ast-window-ring absolute inset-0 size-5 -rotate-90 text-assistant-500"
              style={{ "--ring-length": WINDOW_RING } as React.CSSProperties}
            >
              <circle cx="10" cy="10" r="8" strokeDasharray={WINDOW_RING} />
            </svg>
          </span>
        }
      >
        Say yes, or press Approve
      </Line>
    );
  }

  if (speaking) {
    return <Line icon={<Orb size={20} state="speaking" />}>Reading it back…</Line>;
  }

  // Heard nothing yet, or the read-back was cut off: a yes will count once it has been
  // heard through, and a click works now.
  return (
    <Line icon={<MicIcon className={small} />}>
      Say yes once you have heard it, or press Approve
    </Line>
  );
}
