/**
 * The public estimate review page.
 *
 * Opened from an emailed link by someone with no account — an adjuster, a carrier's
 * reviewer — so it sits **outside every guard** in `router.tsx` and renders its own
 * chrome rather than `AppShell`, which assumes a signed-in profile.
 *
 * The emailed links carry `?action=approve|reject|changes`. That intent is honoured by
 * opening the matching confirmation, and deliberately **not** by performing the action:
 * the whole point of moving these from GET to POST was that a link-scanning email
 * client or security appliance could otherwise approve a construction estimate by
 * merely following a URL. A prefetch of this page renders a form and changes nothing.
 */
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "@/api/client";
import { useReviewEstimate, useSubmitReviewDecision } from "@/api/queries/review";
import type { ReviewDecision } from "@/api/queries/review";
import type { ReviewDecisionOut, ReviewEstimateOut } from "@/api/types";
import { BrandMark } from "@/features/auth/AuthLayout";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { Alert, LoadingState } from "@/components/feedback";
import { Field, Textarea } from "@/components/form";
import { Table, TableWrap, TBody, Td, TFoot, Th, THead, Tr } from "@/components/Table";
import { ESTIMATE_STATUS_LABELS, type EstimateStatus } from "@/domain/enums";
import { formatMoney } from "@/domain/money";
import { formatDateTime } from "@/lib/format";

/** `?action=changes` in the email maps to the `request-changes` endpoint. */
const ACTION_PARAM: Record<string, ReviewDecision> = {
  approve: "approve",
  reject: "reject",
  changes: "request-changes",
};

export function ReviewPage() {
  const { token } = useParams<{ token: string }>();
  const [params] = useSearchParams();
  const { data, isPending, error } = useReviewEstimate(token);

  const [decided, setDecided] = useState<ReviewDecisionOut | null>(null);
  const [pendingAction, setPendingAction] = useState<ReviewDecision | null>(
    () => ACTION_PARAM[params.get("action") ?? ""] ?? null,
  );

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-gray-200 bg-surface">
        <div className="mx-auto flex h-14 max-w-4xl items-center px-4 sm:px-6">
          <BrandMark />
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        {isPending ? (
          <LoadingState label="Loading this estimate…" />
        ) : error ? (
          <LinkProblem error={error} />
        ) : decided ? (
          <Receipt decision={decided} />
        ) : (
          <Review
            token={token!}
            estimate={data}
            pendingAction={pendingAction}
            onOpenAction={setPendingAction}
            onDecided={setDecided}
          />
        )}
      </main>
    </div>
  );
}

/**
 * A link that cannot be used, explained in the reviewer's terms.
 *
 * 404 and 410 mean genuinely different things and the backend separates them
 * deliberately (`review_service.load_by_token`): one is "this link is wrong", the other
 * is "you already answered this". Collapsing them into "something went wrong" would
 * have a reviewer chasing the sender over a decision they already made.
 */
function LinkProblem({ error }: { error: unknown }) {
  const apiError = error instanceof ApiError ? error : null;

  if (apiError?.isGone) {
    return (
      <Panel
        title="This estimate has already been reviewed"
        body={
          apiError.message ||
          "A decision was recorded from this link, so it can no longer be used."
        }
        tone="info"
      />
    );
  }

  if (apiError?.isNotFound) {
    return (
      <Panel
        title="This review link is not valid"
        body="It may have been withdrawn by the sender, or the address may have been copied incompletely. Ask them to send a new link."
        tone="warning"
      />
    );
  }

  return (
    <Panel
      title="This estimate could not be loaded"
      body={apiError?.message ?? "Please try again in a moment."}
      tone="warning"
      {...(apiError?.requestId ? { reference: apiError.requestId } : {})}
    />
  );
}

function Receipt({ decision }: { decision: ReviewDecisionOut }) {
  return (
    <Panel
      title={`${decision.project_name} — ${ESTIMATE_STATUS_LABELS[decision.status as EstimateStatus]}`}
      body={decision.message}
      tone={decision.status === "approved" ? "success" : "info"}
      reference={decision.identifier}
    />
  );
}

function Panel({
  title,
  body,
  tone,
  reference,
}: {
  title: string;
  body: string;
  tone: "success" | "info" | "warning";
  reference?: string;
}) {
  return (
    <div className="rounded-card bg-surface px-6 py-12 text-center ring-1 ring-gray-200">
      <h1 className="font-display text-xl font-semibold text-gray-900">{title}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">{body}</p>
      {reference && (
        <p className="mt-4 font-mono text-xs text-gray-400">{reference}</p>
      )}
      <div className="mx-auto mt-6 max-w-md">
        <Alert tone={tone}>
          You can close this page. Nothing further is needed from you.
        </Alert>
      </div>
    </div>
  );
}

function Review({
  token,
  estimate,
  pendingAction,
  onOpenAction,
  onDecided,
}: {
  token: string;
  estimate: ReviewEstimateOut;
  pendingAction: ReviewDecision | null;
  onOpenAction: (action: ReviewDecision | null) => void;
  onDecided: (decision: ReviewDecisionOut) => void;
}) {
  // `default_factory=list` server-side, so these are always present in practice — but
  // openapi-typescript marks a field with a default as optional on the response.
  const rooms = estimate.rooms ?? [];
  const [notes, setNotes] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const submit = useSubmitReviewDecision(token);

  const closed = !estimate.decision_pending;

  async function decide(decision: ReviewDecision) {
    setFailure(null);
    try {
      const result = await submit.mutateAsync(
        decision === "request-changes" ? { decision, notes } : { decision },
      );
      onDecided(result);
    } catch (caught) {
      // The reviewer cannot retry from a toast they may not see, and there is no
      // session to fall back on, so failures stay on the page until resolved.
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : "The decision could not be recorded. Please try again.",
      );
      onOpenAction(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-card bg-surface p-6 ring-1 ring-gray-200">
        <p className="text-sm text-gray-500">Estimate for review</p>
        <h1 className="mt-1 font-display text-2xl font-semibold text-gray-900">
          {estimate.project_name}
        </h1>

        <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Detail term="Claim ID" value={estimate.identifier} mono />
          <Detail term="Client" value={estimate.client_name} />
          <Detail term="Insurance carrier" value={estimate.insurance_carrier} />
          <Detail term="Project manager" value={estimate.pm_name} />
          <Detail term="Submitted by" value={estimate.submitted_by} />
          <Detail term="Submitted" value={formatDateTime(estimate.submitted_at)} />
        </dl>
      </section>

      {estimate.review_note && (
        <Alert tone="warning">
          <p className="font-medium">Changes you previously requested</p>
          <p className="mt-1 whitespace-pre-wrap">{estimate.review_note}</p>
        </Alert>
      )}

      <section className="flex flex-col gap-4">
        {rooms.length === 0 ? (
          <p className="rounded-card bg-surface px-6 py-10 text-center text-sm text-gray-500 ring-1 ring-gray-200">
            This estimate has no line items.
          </p>
        ) : (
          rooms.map((room, index) => (
            <div key={index} className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-gray-900">{room.name}</h2>
              <TableWrap>
                <Table>
                  <THead>
                    <Tr>
                      <Th>Item</Th>
                      <Th>Unit</Th>
                      <Th numeric>Qty</Th>
                      <Th numeric>Unit cost</Th>
                      <Th numeric>Total</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {(room.items ?? []).map((item, itemIndex) => (
                      <Tr key={itemIndex}>
                        <Td>
                          {item.name}
                          {item.notes && (
                            <span className="mt-0.5 block text-xs text-gray-500">
                              {item.notes}
                            </span>
                          )}
                        </Td>
                        <Td>{item.unit}</Td>
                        <Td numeric>{item.quantity}</Td>
                        <Td numeric>{formatMoney(item.unit_cost)}</Td>
                        <Td numeric>{formatMoney(item.total)}</Td>
                      </Tr>
                    ))}
                  </TBody>
                  <TFoot>
                    <Tr>
                      <Td colSpan={4} className="text-right text-gray-500">
                        {room.name} subtotal
                      </Td>
                      <Td numeric className="font-semibold">
                        {formatMoney(room.total)}
                      </Td>
                    </Tr>
                  </TFoot>
                </Table>
              </TableWrap>
            </div>
          ))
        )}

        <div className="flex items-baseline justify-end gap-3 rounded-card bg-surface px-5 py-4 ring-1 ring-gray-200">
          <span className="text-sm text-gray-500">
            {estimate.room_count} {estimate.room_count === 1 ? "room" : "rooms"} ·{" "}
            {estimate.item_count} {estimate.item_count === 1 ? "item" : "items"}
          </span>
          <output aria-label="Estimate total" className="tnum text-2xl font-semibold text-gray-900">
            {formatMoney(estimate.total)}
          </output>
        </div>
      </section>

      {failure && <Alert tone="danger">{failure}</Alert>}

      {closed ? (
        <Alert tone="info">
          This estimate is already {ESTIMATE_STATUS_LABELS[estimate.status as EstimateStatus]}.
          No further decision is needed.
        </Alert>
      ) : (
        <section className="flex flex-col gap-3 rounded-card bg-surface p-5 ring-1 ring-gray-200">
          <h2 className="font-display text-base font-semibold text-gray-900">Your decision</h2>
          <p className="text-sm text-gray-600">
            Approving or rejecting is final and closes this link. Requesting changes keeps it
            open, so you can return to the same address once the estimate is revised.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="success"
              busy={submit.isPending && pendingAction === "approve"}
              disabled={submit.isPending}
              onClick={() => onOpenAction("approve")}
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              disabled={submit.isPending}
              onClick={() => onOpenAction("request-changes")}
            >
              Request changes
            </Button>
            <Button
              variant="danger"
              busy={submit.isPending && pendingAction === "reject"}
              disabled={submit.isPending}
              onClick={() => onOpenAction("reject")}
            >
              Reject
            </Button>
          </div>
        </section>
      )}

      <Modal
        open={!closed && (pendingAction === "approve" || pendingAction === "reject")}
        onClose={() => onOpenAction(null)}
        title={pendingAction === "reject" ? "Reject this estimate?" : "Approve this estimate?"}
        size="sm"
        footer={
          <>
            <Button onClick={() => onOpenAction(null)} disabled={submit.isPending}>
              Cancel
            </Button>
            <Button
              variant={pendingAction === "reject" ? "danger" : "success"}
              busy={submit.isPending}
              onClick={() => void decide(pendingAction === "reject" ? "reject" : "approve")}
            >
              {pendingAction === "reject" ? "Reject" : "Approve"}
            </Button>
          </>
        }
      >
        <p>
          {estimate.project_name} — {formatMoney(estimate.total)}.
        </p>
        <p className="mt-2">
          This is final and cannot be undone from this link. The team will be notified.
        </p>
      </Modal>

      <Modal
        open={!closed && pendingAction === "request-changes"}
        onClose={() => onOpenAction(null)}
        title="Request changes"
        description="The submitter will receive your note and can revise the estimate."
        footer={
          <>
            <Button onClick={() => onOpenAction(null)} disabled={submit.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={submit.isPending}
              // Stricter than the API on purpose. `notes` is `minLength: 1`, so ""
              // is a 422 — but "   " passes validation, and would email the submitter
              // a change request asking for nothing.
              disabled={notes.trim().length === 0}
              onClick={() => void decide("request-changes")}
            >
              Send request
            </Button>
          </>
        }
      >
        <Field label="What needs to change?" required>
          {(props) => (
            <Textarea
              {...props}
              rows={5}
              value={notes}
              autoFocus
              placeholder="For example: itemise the flooring separately, and confirm the drywall square footage."
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>
      </Modal>
    </div>
  );
}

function Detail({ term, value, mono }: { term: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-gray-500 uppercase">{term}</dt>
      <dd className={mono ? "font-mono text-gray-900" : "text-gray-900"}>{value || "—"}</dd>
    </div>
  );
}
