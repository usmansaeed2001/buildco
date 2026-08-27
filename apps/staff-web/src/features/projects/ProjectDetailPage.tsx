/**
 * A project, in full.
 *
 * One request carries the project plus its milestones, supplements and activity via
 * `?include=`, so the screen has no waterfall of dependent fetches.
 *
 * The status badge is accompanied by *why* it says what it does. `closed` and
 * `pending_payment` are conclusions the rules engine reaches from milestones and closing
 * forms — they change without anyone touching the status field, and a badge that
 * silently changes with no stated cause is how people stop trusting the board.
 * `deriveProjectState` in `domain/projectRules` re-derives the same answer to explain it,
 * and is pinned against the Python engine's own output.
 */
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "@/api/client";
import {
  useDeleteProject,
  useProject,
  useUpdateProject,
  useUpdateProjectStatus,
} from "@/api/queries/projects";
import { useAssignableUsers } from "@/api/queries/users";
import { useActor } from "@/auth/useAuth";
import { Button } from "@/components/Button";
import { ProjectStatusBadge } from "@/components/Badge";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert, Card, ErrorState, LoadingState } from "@/components/feedback";
import { Field, Input, Select, TextField, Textarea } from "@/components/form";
import { useToast } from "@/components/Toast";
import {
  PROJECT_STATUS_LABELS,
  SETTABLE_PROJECT_STATUSES,
  type ProjectStatus,
} from "@/domain/enums";
import { toDecimal, toMoneyString, ZERO } from "@/domain/money";
import {
  canDeleteMilestone,
  canDeleteProject,
  canEditProject,
  canManageMilestones,
  canSetProjectStatus,
  canSubmitClosingForms,
  deriveProjectState,
  type ProjectSnapshot,
} from "@/domain/projectRules";
import { displayName } from "@/lib/format";
import { ActivityFeed } from "./ActivityFeed";
import { BudgetSummary } from "./BudgetSummary";
import { ClosingFormsCard } from "./ClosingFormsCard";
import { LinkedSupplements } from "./LinkedSupplements";
import { MilestoneList } from "./MilestoneList";
import { WorkStatusStepper } from "./WorkStatusStepper";

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data, isPending, error, refetch } = useProject(projectId);
  const actor = useActor();

  if (isPending || !actor) return <LoadingState label="Loading project…" />;

  if (error) {
    // A member who is not assigned gets a 404, not a 403 — the project's existence is
    // itself privileged. Saying "not found" is the honest surface of that.
    const notFound = error instanceof ApiError && error.isNotFound;
    return (
      <div className="flex flex-col items-center gap-4">
        <ErrorState error={error} {...(notFound ? {} : { onRetry: () => void refetch() })} />
        <Link to="/projects" className="text-sm text-brand-700 underline">
          Back to projects
        </Link>
      </div>
    );
  }

  return <Detail key={data.project.id} detail={data} actor={actor} />;
}

function Detail({
  detail,
  actor,
}: {
  detail: NonNullable<ReturnType<typeof useProject>["data"]>;
  actor: NonNullable<ReturnType<typeof useActor>>;
}) {
  const { project } = detail;
  const milestones = detail.milestones ?? [];
  const supplements = detail.supplements ?? [];
  const activity = detail.activity ?? [];

  const toast = useToast();
  const navigate = useNavigate();
  const setStatus = useUpdateProjectStatus(project.id);
  const remove = useDeleteProject();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const snapshot: ProjectSnapshot = {
    workStatus: project.work_status,
    status: project.status as ProjectStatus,
    hasClosingForm1: project.closing_form_1 !== null && project.closing_form_1 !== undefined,
    hasClosingForm2: project.closing_form_2 !== null && project.closing_form_2 !== undefined,
    milestones: milestones.map((milestone) => ({ paid: milestone.paid })),
    assignedTo: project.assigned_to ?? null,
  };

  const derived = deriveProjectState(snapshot);
  const editable = canEditProject(actor);
  const manageMilestones = canManageMilestones(actor, snapshot);

  // Not memoised. `detail.supplements ?? []` is a fresh array every render, so a
  // `useMemo` keyed on it would recompute anyway while claiming not to — and summing a
  // handful of Decimals is far cheaper than the comparison would be.
  const supplementsTotal = supplements.reduce(
    (sum, supplement) => sum.plus(toDecimal(supplement.estimate?.total)),
    ZERO,
  );

  async function changeStatus(next: ProjectStatus) {
    try {
      await setStatus.mutateAsync(next);
      toast.success(`Project marked ${PROJECT_STATUS_LABELS[next].toLowerCase()}.`);
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : "The status could not be changed.",
      );
    }
  }

  async function confirmDelete() {
    setConfirmingDelete(false);
    try {
      await remove.mutateAsync(project.id);
      toast.success("Project deleted.");
      navigate("/projects");
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : "The project could not be deleted.",
      );
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/projects" className="text-sm text-gray-500 hover:text-gray-800">
            &larr; Projects
          </Link>
          <h1 className="mt-1 truncate text-2xl font-semibold text-gray-900">
            {project.owner_name || "Unnamed owner"}
          </h1>
          <p className="truncate text-sm text-gray-500">{project.address || "No address"}</p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <ProjectStatusBadge status={project.status as ProjectStatus} />
            {canSetProjectStatus(actor) && (
              <Select
                aria-label="Set project status"
                value=""
                disabled={setStatus.isPending}
                onChange={(event) => void changeStatus(event.target.value as ProjectStatus)}
                className="w-auto"
              >
                <option value="" disabled>
                  Change…
                </option>
                {/* Only `active` and `cancelled`. The other two are conclusions the
                    rules engine reaches, and the API rejects setting them with a 422. */}
                {SETTABLE_PROJECT_STATUSES.filter((value) => value !== project.status).map(
                  (value) => (
                    <option key={value} value={value}>
                      {PROJECT_STATUS_LABELS[value]}
                    </option>
                  ),
                )}
              </Select>
            )}
          </div>
          <p className="max-w-xs text-right text-xs text-gray-500">{derived.reason}</p>
        </div>
      </header>

      {derived.status !== project.status && (
        // The two disagreeing means a mutation landed without the rules engine running,
        // which should be impossible. Saying so beats rendering a quietly wrong badge.
        <Alert tone="warning">
          This project is stored as {PROJECT_STATUS_LABELS[project.status as ProjectStatus]} but
          its milestones and closing forms indicate{" "}
          {PROJECT_STATUS_LABELS[derived.status]}. Reload; if it persists, report it.
        </Alert>
      )}

      <Card className="p-5">
        <WorkStatusStepper
          projectId={project.id}
          workStatus={project.work_status}
          readOnly={project.status === "cancelled"}
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-5">
          <ProjectDetailsCard project={project} readOnly={!editable} />

          <MilestoneList
            projectId={project.id}
            milestones={milestones}
            canManage={manageMilestones}
            canDelete={canDeleteMilestone(actor)}
          />

          <LinkedSupplements
            projectId={project.id}
            supplements={supplements}
            canManage={manageMilestones}
          />

          <ClosingFormsCard
            project={project}
            canSubmit={canSubmitClosingForms(actor, snapshot) && project.status !== "cancelled"}
          />
        </div>

        <div className="flex flex-col gap-5">
          <BudgetSummary
            project={project}
            supplementsTotal={supplementsTotal}
            readOnly={!editable}
          />
          <ActivityFeed activity={activity} />

          {canDeleteProject(actor) && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="text-danger-600 hover:bg-danger-50"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete project
              </Button>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete this project?"
        confirmLabel="Delete permanently"
        busy={remove.isPending}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => void confirmDelete()}
      >
        <p>
          <strong>{project.owner_name || project.address || "This project"}</strong>, its{" "}
          {milestones.length} {milestones.length === 1 ? "milestone" : "milestones"} and its
          activity history will be destroyed.
        </p>
        <p className="mt-2">
          Unlike an estimate, there is no trash for projects — this cannot be undone. To take a
          project out of the active list instead, mark it cancelled.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/** The editable facts about the job. Autosaves on blur, like the budget figures. */
function ProjectDetailsCard({
  project,
  readOnly,
}: {
  project: NonNullable<ReturnType<typeof useProject>["data"]>["project"];
  readOnly: boolean;
}) {
  const toast = useToast();
  const update = useUpdateProject(project.id);
  const { data: users } = useAssignableUsers();

  async function save(body: Record<string, unknown>) {
    try {
      await update.mutateAsync(body);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "That change could not be saved.");
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">Details</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Home owner"
          defaultValue={project.owner_name}
          disabled={readOnly}
          onBlur={(event) =>
            event.target.value !== project.owner_name &&
            void save({ owner_name: event.target.value })
          }
        />
        <TextField
          label="Address"
          defaultValue={project.address}
          disabled={readOnly}
          onBlur={(event) =>
            event.target.value !== project.address && void save({ address: event.target.value })
          }
        />
        <TextField
          label="Type of work"
          defaultValue={project.work_type}
          disabled={readOnly}
          onBlur={(event) =>
            event.target.value !== project.work_type &&
            void save({ work_type: event.target.value })
          }
        />

        <Field label="Start date">
          {(props) => (
            <Input
              {...props}
              type="date"
              defaultValue={project.start_date ?? ""}
              disabled={readOnly}
              onBlur={(event) =>
                (event.target.value || null) !== project.start_date &&
                void save({ start_date: event.target.value || null })
              }
            />
          )}
        </Field>

        <Field label="Assigned to">
          {(props) => (
            <Select
              {...props}
              value={project.assigned_to ?? ""}
              disabled={readOnly}
              onChange={(event) => void save({ assigned_to: event.target.value || null })}
            >
              <option value="">Unassigned</option>
              {(users ?? []).map((user) => (
                <option key={user.id} value={user.id}>
                  {displayName(user)}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Total budget">
          {(props) => (
            <Input
              {...props}
              inputMode="decimal"
              className="tnum text-right"
              defaultValue={project.total_budget}
              disabled={readOnly}
              onFocus={(event) => event.target.select()}
              onBlur={(event) =>
                toMoneyString(event.target.value) !== toMoneyString(project.total_budget) &&
                void save({ total_budget: toMoneyString(event.target.value) })
              }
            />
          )}
        </Field>
      </div>

      <Field label="Notes">
        {(props) => (
          <Textarea
            {...props}
            rows={3}
            defaultValue={project.notes}
            disabled={readOnly}
            onBlur={(event) =>
              event.target.value !== project.notes && void save({ notes: event.target.value })
            }
          />
        )}
      </Field>
    </Card>
  );
}
