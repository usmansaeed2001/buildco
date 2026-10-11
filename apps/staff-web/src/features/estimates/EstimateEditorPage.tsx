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
 *
 * The one exception is a write this editor did not make: see `reseed`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "@/api/client";
import type { EstimateOut } from "@/api/types";
import { useAttachments } from "@/api/queries/attachments";
import { useTeamSettings } from "@/api/queries/settings";
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
import { ITEM_CATEGORIES, ITEM_UNITS, type EstimateStatus } from "@/domain/enums";
import { computeTotals } from "@/domain/estimateTotals";
import { canEdit } from "@/domain/estimateRules";
import type { ActorSnapshot, EstimateSnapshot, TransitionAction } from "@/domain/estimateRules";
import { formatMoney } from "@/domain/money";
import { downloadCsv } from "@/lib/csv";
import { formatDateTime } from "@/lib/format";
import { readRooms, toWireRooms } from "./document";
import type { EstimateDetails } from "./document";
import { buildEstimateCsv, estimateCsvFilename } from "./estimateCsv";
import { useAutosave, type SaveState } from "./useAutosave";
import { useEstimateDocument } from "./useEstimateDocument";
import { LineItemsTable } from "./LineItemsTable";
import { ProjectDetailsTab } from "./ProjectDetailsTab";
import { EstimateToolbar } from "./EstimateToolbar";
import { CataloguePicker } from "./CataloguePicker";
import { ParseNotesDrawer } from "./ParseNotesDrawer";
import { ReportModal } from "./ReportModal";
import { SubmitForReviewModal } from "./SubmitForReviewModal";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/api/queries/keys";
import { useQueryClient } from "@tanstack/react-query";
import { useAgent, useAgentRecord, useStagedProposal } from "@/features/agent/AgentProvider";
import { RoomRail } from "./RoomRail";

const TABS = [
  { id: "items", label: "Line Items" },
  { id: "details", label: "Supplement Details" },
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
          <Link to="/estimates" className="text-sm text-brand-700 dark:text-brand-300 underline">
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
  const [showParse, setShowParse] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showCatalogue, setShowCatalogue] = useState(false);

  const snapshot: EstimateSnapshot = {
    status: estimate.status as EstimateStatus,
    createdBy: estimate.created_by ?? null,
    isTrashed: Boolean(estimate.deleted_at),
  };
  const editable = canEdit(actor, snapshot) && !snapshot.isTrashed;

  const [details, setDetails] = useState<EstimateDetails>(() => detailsOf(estimate));
  const document = useEstimateDocument(useMemo(() => readRooms(estimate.rooms), [estimate.rooms]));

  // Fetched once for the whole estimate rather than per row: the list is small, and a
  // request per line item would be dozens of round trips for one screen.
  const { data: attachments } = useAttachments(estimate.id);

  // Built-ins first, then whatever the team added in Settings. Both are only what the
  // dropdowns *offer* — `LineItem.category` and `.unit` are bounded strings server-side,
  // so a legacy value on an existing row is kept rather than rewritten.
  const { data: teamSettings } = useTeamSettings();
  const units = useMemo(
    () => [...ITEM_UNITS, ...(teamSettings?.custom_units ?? [])],
    [teamSettings?.custom_units],
  );
  const categories = useMemo(
    () => [...ITEM_CATEGORIES, ...(teamSettings?.custom_categories ?? [])],
    [teamSettings?.custom_categories],
  );

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

  const totals = computeTotals(document.rooms);

  /**
   * Take a fresh copy from the server into the editor's own state.
   *
   * The editor seeds its details and rooms once, when it opens, and from then on the
   * screen is the source and the server follows it. That is right while the only writer
   * is this editor. When something else has written the estimate, the local copy is the
   * stale one, and the next keystroke would autosave the whole payload and put the old
   * values back. So a write made elsewhere is followed by this: both halves of the
   * document are replaced, the undo history with them, and the result is marked as
   * already saved so that taking it in does not itself trigger a save.
   */
  function reseed(fresh: EstimateOut) {
    const nextDetails = detailsOf(fresh);
    const nextRooms = readRooms(fresh.rooms);
    setDetails(nextDetails);
    // `reset` goes back to the first room. Stay on the one being looked at; if it no
    // longer exists the document clamps the selection itself.
    const viewing = document.activeIndex;
    document.reset(nextRooms);
    if (viewing !== null) document.selectRoom(viewing);
    // Same shape and key order as `payload` below, since this is compared as text.
    autosave.markSaved({ ...nextDetails, rooms: nextRooms });
  }

  // ── BuildCo Assistant ─────────────────────────────────────────────────────
  //
  // Three things, all so that the assistant and this editor never disagree about what
  // the supplement holds.
  //
  // It is told which supplement is open and whether its edits are saved, and it is
  // given a way to make sure they are: a change proposed against a document with a save
  // still on its way would be checked against something about to change.
  const agent = useAgent();
  useAgentRecord(
    { type: "supplement", id: estimate.id, label: details.project_name },
    autosave.state,
  );
  const flushRef = useRef(autosave.flush);
  flushRef.current = autosave.flush;
  const registerEditor = agent?.registerEditor;
  useEffect(() => {
    if (!registerEditor) return;
    registerEditor({ supplementId: estimate.id, flush: () => flushRef.current() });
    return () => registerEditor(null);
  }, [registerEditor, estimate.id]);

  // What it proposes for this supplement is staged here, and it is told so once shown.
  const assistant = useStagedProposal(
    "supplement.update_details",
    "supplement.transition",
    "supplement.submit",
  );
  const staged =
    assistant.staged?.payload["supplement_id"] === estimate.id ? assistant.staged : null;
  const stagedId = staged?.id;
  const { confirm: confirmStaged, takeHandover, handover, commits, lastTarget } = assistant;
  useEffect(() => {
    if (stagedId) confirmStaged(stagedId);
  }, [stagedId, confirmStaged]);
  // After Stop there is nothing to hand over: these are confirmations, not forms. The
  // staged dialog closes and nothing was written.
  useEffect(() => {
    if (handover) takeHandover();
  }, [handover, takeHandover]);

  // And when it has committed a change to this supplement, the saved values are taken
  // in. Without this the editor would still hold the old ones, and the next keystroke
  // would autosave the whole payload and silently undo what was just approved.
  const reseedRef = useRef(reseed);
  reseedRef.current = reseed;
  const isDirtyRef = useRef(autosave.isDirty);
  isDirtyRef.current = autosave.isDirty;
  const seenCommits = useRef(commits);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (commits === seenCommits.current) return;
    seenCommits.current = commits;
    if (lastTarget?.type !== "supplement" || lastTarget.id !== estimate.id) return;
    let current = true;
    void apiFetch<EstimateOut>(`/estimates/${estimate.id}`).then((fresh) => {
      if (!current) return;
      queryClient.setQueryData(queryKeys.estimates.detail(estimate.id), fresh);
      if (!isDirtyRef.current()) reseedRef.current(fresh);
    });
    return () => {
      current = false;
    };
  }, [commits, lastTarget, estimate.id, queryClient]);

  async function runTransition(action: TransitionAction) {
    // Save pending edits first, and wait for it: a transition replies with the whole
    // estimate, and a save still in flight would land on top of a stale server copy.
    // If the save fails the status is left alone; the banner already says why.
    try {
      await autosave.flush();
    } catch {
      toast.error("Could not save your changes, so the status was not changed.");
      return;
    }
    try {
      const updated = await transition.mutateAsync(action);
      // Not if something was typed while the request was in flight: those edits are
      // newer than the reply, and a transition changes the status, not the contents.
      if (!autosave.isDirty()) reseed(updated);
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
            onGenerateReport={() => setShowReport(true)}
            {...(editable ? { onParseNotes: () => setShowParse(true) } : {})}
            onSubmitForReview={() => {
              // Save first, and wait: the reviewer must be emailed the estimate as it
              // stands on screen, not the copy from before the last debounce. If the
              // save fails there is nothing to submit yet, and the banner says why.
              void autosave.flush().then(
                () => setShowSubmit(true),
                () => toast.error("Could not save your changes, so nothing was sent."),
              );
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
            {/* A failed retry is already reported by this banner, so the rejection has
                nowhere further to go. */}
            <Button size="sm" onClick={() => void autosave.flush().catch(() => undefined)}>
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

      <TabList tabs={TABS} active={tab} onChange={setTab} label="Estimate sections" />

      <TabPanel id="items" active={tab}>
        {/* `minmax(0,1fr)`, not `1fr`. A bare `1fr` track cannot be narrower than its
            widest content, and the line-items table is about 1030px at its narrowest, so
            the track grew to fit it and pushed the page sideways instead of letting the
            table scroll inside its own card. Beside a panel that meant the table ran
            underneath the panel. */}
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-5 app-lg:grid-cols-[240px_minmax(0,1fr)]">
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
              units={units}
              categories={categories}
              readOnly={!editable}
              onAddItem={document.addItem}
              onAddFromCatalogue={() => setShowCatalogue(true)}
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

      <CataloguePicker
        open={showCatalogue}
        onClose={() => setShowCatalogue(false)}
        onPick={document.addPreparedItem}
      />

      <ParseNotesDrawer
        open={showParse}
        hasExistingRooms={document.rooms.length > 0}
        onClose={() => setShowParse(false)}
        onApply={document.applyRooms}
      />

      <ReportModal
        open={showReport}
        onClose={() => setShowReport(false)}
        report={{
          identifier: estimate.identifier,
          status: estimate.status as EstimateStatus,
          details,
          rooms: document.rooms,
          // Already fetched above for the line-item thumbnails, so the report costs no
          // extra request. It was simply never passed through — which is why the PDF has
          // had no photos in it.
          attachments: attachments ?? [],
        }}
      />

      <SubmitForReviewModal
        open={showSubmit}
        estimateId={estimate.id}
        projectName={details.project_name}
        total={totals.total}
        onClose={() => setShowSubmit(false)}
      />

      {/* What the assistant proposes for this supplement. Read-only, and approved or
          rejected from its panel: nothing here is a button the user presses. */}
      {staged?.kind === "supplement.submit" && (
        <SubmitForReviewModal
          key={staged.id}
          open
          staged
          estimateId={estimate.id}
          projectName={details.project_name}
          total={totals.total}
          onClose={() => {}}
        />
      )}
      {staged?.kind === "supplement.transition" && (
        <ConfirmDialog
          key={staged.id}
          open
          staged
          tone="primary"
          title={`${staged.labels.action_label ?? "Change the status of"} this supplement?`}
          confirmLabel={staged.labels.action_label ?? "Confirm"}
          onConfirm={() => {}}
          onCancel={() => {}}
        >
          <p className="text-sm text-gray-700">{staged.summary}</p>
        </ConfirmDialog>
      )}
      {staged?.kind === "supplement.update_details" && (
        <Modal key={staged.id} open staged title="Change details" onClose={() => {}}>
          <table className="w-full text-left text-sm">
            <thead className="text-gray-500">
              <tr>
                <th className="pr-3 pb-1 font-medium">Detail</th>
                <th className="pr-3 pb-1 font-medium">Now</th>
                <th className="pb-1 font-medium">Would become</th>
              </tr>
            </thead>
            <tbody>
              {(staged.labels.changes ?? []).map((change) => (
                <tr key={change.field} className="border-t border-gray-100 align-top">
                  <th scope="row" className="py-1.5 pr-3 font-medium text-gray-700">
                    {change.label}
                  </th>
                  <td className="py-1.5 pr-3 whitespace-pre-wrap text-gray-500">
                    {change.old || "blank"}
                  </td>
                  <td className="py-1.5 whitespace-pre-wrap text-gray-900">
                    {change.new || "blank"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}

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

/** The fields of an estimate that the details tab edits, in the order they are saved. */
function detailsOf(estimate: EstimateOut): EstimateDetails {
  return {
    project_name: estimate.project_name,
    client_name: estimate.client_name,
    pm_name: estimate.pm_name,
    insurance_carrier: estimate.insurance_carrier,
    notes: estimate.notes,
  };
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
      className={state === "error" ? "text-xs text-danger-600 dark:text-danger-400" : "text-xs text-gray-400"}
    >
      {text}
    </span>
  );
}
