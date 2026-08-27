/**
 * The estimate editor.
 *
 * The document — details plus rooms — is local state, seeded once from the fetched
 * estimate and written back by a debounced autosave. It is deliberately *not* driven by
 * the query cache: a controlled input whose value comes from a refetch loses the
 * caret on every save, which is what made the legacy editor feel like it was fighting
 * you when the connection was slow.
 *
 * Seeding happens on the estimate's id rather than on every change to the query data.
 * Re-seeding from a background refetch would discard whatever the user had typed since.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "@/api/client";
import type { EstimateOut } from "@/api/types";
import { useAttachments } from "@/api/queries/attachments";
import {
  useEstimate,
  useEstimateTransition,
  useTrashEstimate,
  useUpdateEstimate,
} from "@/api/queries/estimates";
import { useActor } from "@/auth/useAuth";
import { Button } from "@/components/Button";
import { EstimateStatusBadge } from "@/components/Badge";
import { Alert, ErrorState, LoadingState } from "@/components/feedback";
import { Modal } from "@/components/Modal";
import { TabList, TabPanel, useTabParam } from "@/components/Tabs";
import { useToast } from "@/components/Toast";
import type { EstimateStatus } from "@/domain/enums";
import { computeTotals } from "@/domain/estimateTotals";
import { canEdit } from "@/domain/estimateRules";
import type { ActorSnapshot, EstimateSnapshot, TransitionAction } from "@/domain/estimateRules";
import { formatMoney } from "@/domain/money";
import { downloadCsv } from "@/lib/csv";
import { formatDateTime } from "@/lib/format";
import { hasUnsupportedCategory, readRooms, toWireRooms } from "./document";
import type { EstimateDetails } from "./document";
import { buildEstimateCsv, estimateCsvFilename } from "./estimateCsv";
import { useAutosave, type SaveState } from "./useAutosave";
import { useEstimateDocument } from "./useEstimateDocument";
import { LineItemsTable } from "./LineItemsTable";
import { ProjectDetailsTab } from "./ProjectDetailsTab";
import { EstimateToolbar } from "./EstimateToolbar";
import { SubmitForReviewModal } from "./SubmitForReviewModal";
import { RoomRail } from "./RoomRail";

const TABS = [
  { id: "items", label: "Line Items" },
  { id: "details", label: "Project Details" },
] as const;

export function EstimateEditorPage() {
  const { estimateId } = useParams<{ estimateId: string }>();
  const { data: estimate, isPending, error, refetch } = useEstimate(estimateId);
  const actor = useActor();

  if (isPending || !actor) return <LoadingState label="Loading estimate…" />;
  if (error) {
    const notFound = error instanceof ApiError && error.isNotFound;
    return (
      <div className="flex flex-col items-center gap-4">
        <ErrorState error={error} {...(notFound ? {} : { onRetry: () => void refetch() })} />
        {notFound && (
          <Link to="/estimates" className="text-sm text-brand-700 underline">
            Back to supplements
          </Link>
        )}
      </div>
    );
  }

  // Keyed on the id so switching estimates rebuilds the document rather than carrying
  // one estimate's unsaved edits into another.
  return <Editor key={estimate.id} estimate={estimate} actor={actor} />;
}

function Editor({ estimate, actor }: { estimate: EstimateOut; actor: ActorSnapshot }) {
  const toast = useToast();
  const [tab, setTab] = useTabParam(TABS);
  const [showChanges, setShowChanges] = useState(false);
  const [showSubmit, setShowSubmit] = useState(false);

  const snapshot: EstimateSnapshot = {
    status: estimate.status as EstimateStatus,
    createdBy: estimate.created_by ?? null,
    isTrashed: Boolean(estimate.deleted_at),
  };
  const editable = canEdit(actor, snapshot) && !snapshot.isTrashed;

  const [details, setDetails] = useState<EstimateDetails>(() => ({
    project_name: estimate.project_name,
    client_name: estimate.client_name,
    pm_name: estimate.pm_name,
    insurance_carrier: estimate.insurance_carrier,
    notes: estimate.notes,
  }));
  const document = useEstimateDocument(useMemo(() => readRooms(estimate.rooms), [estimate.rooms]));

  // Fetched once for the whole estimate rather than per row: the list is small, and a
  // request per line item would be dozens of round trips for one screen.
  const { data: attachments } = useAttachments(estimate.id);

  const updateEstimate = useUpdateEstimate(estimate.id);
  const transition = useEstimateTransition(estimate.id);
  const trash = useTrashEstimate();

  const payload = useMemo(
    () => ({ ...details, rooms: document.rooms }),
    [details, document.rooms],
  );

  const autosave = useAutosave({
    value: payload,
    enabled: editable,
    save: (value) =>
      // Built field by field. Spreading the fetched estimate would send `id` and
      // `status`, and `EstimateUpdate` forbids unknown keys — a 422 for the whole save.
      updateEstimate.mutateAsync({
        project_name: value.project_name,
        client_name: value.client_name,
        pm_name: value.pm_name,
        insurance_carrier: value.insurance_carrier,
        notes: value.notes,
        rooms: toWireRooms(value.rooms),
      }),
  });

  // A stored row carrying `electrical` or `plumbing` will be written back as `other`,
  // and silently rewriting someone's data is not acceptable even when it is the only
  // way to keep the estimate saveable. Count them so the banner can say how many.
  const coercedCount = useMemo(
    () =>
      (estimate.rooms ?? []).reduce((count, room) => {
        const items = (room as { items?: unknown }).items;
        if (!Array.isArray(items)) return count;
        return count + items.filter((item) => hasUnsupportedCategory(item ?? {})).length;
      }, 0),
    [estimate.rooms],
  );

  const totals = computeTotals(document.rooms);

  async function runTransition(action: TransitionAction) {
    // Commit pending edits first: a transition replies with the whole estimate, and a
    // debounce still in flight would be written on top of a stale server copy.
    autosave.flush();
    try {
      await transition.mutateAsync(action);
      toast.success("Status updated.");
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "Could not change the status.");
    }
  }

  async function runDelete() {
    try {
      await trash.mutateAsync(estimate.id);
      toast.success("Moved to the trash.");
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "Could not delete the estimate.");
    }
  }

  function exportCsv() {
    downloadCsv(
      estimateCsvFilename(estimate.identifier),
      buildEstimateCsv({
        identifier: estimate.identifier,
        status: estimate.status as EstimateStatus,
        details,
        rooms: document.rooms,
      }),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link to="/estimates" className="text-sm text-gray-500 hover:text-gray-800">
              &larr; Supplements
            </Link>
            <h1 className="mt-1 truncate text-2xl font-semibold text-gray-900">
              {details.project_name || "Untitled estimate"}
            </h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <span className="font-mono">{estimate.identifier}</span>
              <EstimateStatusBadge status={estimate.status as EstimateStatus} />
              <SaveIndicator state={autosave.state} editable={editable} />
            </p>
          </div>

          <div className="text-right">
            {/* `<output>` rather than a `<p>`: this is a value computed from the form
                below it, which is exactly what the element is for, and it gives the
                figure an accessible name that distinguishes it from the identical room
                subtotals elsewhere on the page. */}
            <output
              aria-label="Estimate total"
              className="tnum block text-2xl font-semibold text-gray-900"
            >
              {formatMoney(totals.total)}
            </output>
            <p className="text-xs text-gray-500">
              {totals.roomCount} {totals.roomCount === 1 ? "room" : "rooms"} · {totals.itemCount}{" "}
              {totals.itemCount === 1 ? "item" : "items"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={document.undo}
                disabled={!document.canUndo}
                aria-label="Undo"
                title="Undo"
              >
                &#8630; Undo
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={document.redo}
                disabled={!document.canRedo}
                aria-label="Redo"
                title="Redo"
              >
                &#8631; Redo
              </Button>
            </div>
          )}

          <EstimateToolbar
            actor={actor}
            snapshot={snapshot}
            busyAction={
              transition.isPending
                ? (transition.variables as TransitionAction)
                : trash.isPending
                  ? "delete"
                  : null
            }
            onTransition={(action) => void runTransition(action)}
            onDelete={() => void runDelete()}
            onExportCsv={exportCsv}
            onSubmitForReview={() => {
              // Commit first: the reviewer must be emailed the estimate as it stands on
              // screen, not the copy from before the last debounce.
              autosave.flush();
              setShowSubmit(true);
            }}
          />

          {estimate.review_note && (
            <Button size="sm" variant="secondary" onClick={() => setShowChanges(true)}>
              View changes requested
            </Button>
          )}
        </div>
      </header>

      {autosave.state === "error" && (
        <Alert tone="danger">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Changes are not being saved.{" "}
              {autosave.error instanceof ApiError ? autosave.error.message : "The request failed."}
            </span>
            <Button size="sm" onClick={autosave.flush}>
              Retry now
            </Button>
          </div>
        </Alert>
      )}

      {snapshot.isTrashed && (
        <Alert tone="warning">
          This estimate is in the trash and cannot be edited. Restore it from the trash view to
          make changes.
        </Alert>
      )}

      {!editable && !snapshot.isTrashed && (
        <Alert tone="info">
          {snapshot.status === "locked"
            ? "This estimate is locked. Only the owner can edit it."
            : "You have read-only access to this estimate."}
        </Alert>
      )}

      {coercedCount > 0 && editable && (
        <Alert tone="warning">
          {coercedCount} {coercedCount === 1 ? "line uses a category" : "lines use categories"} this
          version no longer supports (such as <code>electrical</code>). They now show as{" "}
          <code>other</code>, and saving will store them that way.
        </Alert>
      )}

      <TabList tabs={TABS} active={tab} onChange={setTab} label="Estimate sections" />

      <TabPanel id="items" active={tab}>
        <div className="mt-4 grid gap-5 lg:grid-cols-[240px_1fr]">
          <RoomRail
            rooms={document.rooms}
            activeIndex={document.activeIndex}
            readOnly={!editable}
            onSelect={document.selectRoom}
            onAdd={document.addRoom}
            onRename={document.renameRoom}
            onDelete={document.deleteRoom}
          />

          {document.activeRoom ? (
            <LineItemsTable
              room={document.activeRoom}
              roomIndex={document.activeIndex ?? 0}
              estimateId={estimate.id}
              attachments={attachments ?? []}
              readOnly={!editable}
              onAddItem={document.addItem}
              onUpdateItem={document.updateItem}
              onDeleteItem={document.deleteItem}
            />
          ) : (
            <div className="rounded-card bg-surface px-6 py-16 text-center ring-1 ring-gray-200">
              <p className="font-medium text-gray-900">No rooms yet</p>
              <p className="mt-1 text-sm text-gray-500">
                {editable
                  ? "Add a room to start listing work."
                  : "Nothing has been added to this estimate."}
              </p>
              {editable && (
                <Button variant="primary" size="sm" className="mt-4" onClick={document.addRoom}>
                  + Add room
                </Button>
              )}
            </div>
          )}
        </div>
      </TabPanel>

      <TabPanel id="details" active={tab}>
        <ProjectDetailsTab
          details={details}
          identifier={estimate.identifier}
          readOnly={!editable}
          onChange={(field, value) => setDetails((current) => ({ ...current, [field]: value }))}
        />
      </TabPanel>

      <SubmitForReviewModal
        open={showSubmit}
        estimateId={estimate.id}
        projectName={details.project_name}
        total={totals.total}
        onClose={() => setShowSubmit(false)}
      />

      <Modal
        open={showChanges}
        onClose={() => setShowChanges(false)}
        title="Changes requested"
        {...(estimate.reviewed_at
          ? { description: `Reviewed ${formatDateTime(estimate.reviewed_at)}` }
          : {})}
      >
        <p className="whitespace-pre-wrap text-sm text-gray-700">{estimate.review_note}</p>
      </Modal>
    </div>
  );
}

/** Autosave's state in words. A silent editor is indistinguishable from a broken one. */
function SaveIndicator({ state, editable }: { state: SaveState; editable: boolean }) {
  if (!editable) return null;

  const copy: Record<SaveState, string | null> = {
    idle: null,
    pending: "Unsaved changes",
    saving: "Saving…",
    saved: "Saved",
    // The banner carries the detail; this only keeps the header honest.
    error: "Not saved",
  };

  const text = copy[state];
  if (!text) return null;

  return (
    <span
      // Announced without stealing focus, so a screen-reader user learns the save
      // failed without being yanked out of the cell they are typing in.
      role="status"
      className={state === "error" ? "text-xs text-danger-600" : "text-xs text-gray-400"}
    >
      {text}
    </span>
  );
}
