/**
 * Where the physical work stands.
 *
 * Click a stage to set it. **Any assigned user can**, not just an admin — this is the
 * crew's own progress, and requiring a manager to record it is how a status board stops
 * matching reality.
 *
 * Setting a stage is optimistic, with a rollback: the request is a round trip and the
 * stepper is the one control someone taps repeatedly while standing on a job site with
 * poor signal.
 *
 * `on_hold` sits outside the sequence deliberately. It is entered from anywhere and left
 * back to wherever you were, not a stage between two others, and rendering it inline
 * would imply every project passes through it.
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import { useUpdateWorkStatus } from "@/api/queries/projects";
import { Button, Spinner } from "@/components/Button";
import { useToast } from "@/components/Toast";
import { WORK_STATUS_LABELS, type WorkStatus } from "@/domain/enums";
import { WORK_STATUS_ASIDE, WORK_STATUS_SEQUENCE, workStatusIndex } from "@/domain/projectRules";
import { cn } from "@/lib/cn";

export function WorkStatusStepper({
  projectId,
  workStatus,
  readOnly,
}: {
  projectId: string;
  workStatus: WorkStatus;
  readOnly: boolean;
}) {
  const toast = useToast();
  const update = useUpdateWorkStatus(projectId);

  // The value shown while a request is in flight. Cleared on settle, at which point the
  // refetched project is authoritative again.
  const [optimistic, setOptimistic] = useState<WorkStatus | null>(null);
  const shown = optimistic ?? workStatus;
  const currentIndex = workStatusIndex(shown);

  async function set(next: WorkStatus) {
    if (readOnly || next === shown) return;

    setOptimistic(next);
    try {
      await update.mutateAsync(next);
    } catch (caught) {
      // Roll back rather than leave the board showing something the server rejected.
      setOptimistic(null);
      toast.error(
        caught instanceof ApiError ? caught.message : "The work status could not be updated.",
      );
      return;
    }
    setOptimistic(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">
          Work progress
        </h2>
        {update.isPending && <Spinner className="size-4 text-gray-400" />}
      </div>

      <ol className="flex flex-wrap gap-1.5">
        {WORK_STATUS_SEQUENCE.map((stage, index) => {
          const isCurrent = stage === shown;
          // Everything before the current stage counts as passed. When the project is
          // on hold, currentIndex is -1 and nothing is marked done — which is honest:
          // a held project is not "at" any stage.
          const isDone = currentIndex >= 0 && index < currentIndex;

          return (
            <li key={stage}>
              <button
                type="button"
                disabled={readOnly || update.isPending}
                aria-current={isCurrent ? "step" : undefined}
                onClick={() => void set(stage)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                  isCurrent
                    ? "bg-brand-600 text-white"
                    : isDone
                      ? "bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100"
                      : "bg-white text-gray-500 ring-1 ring-inset ring-gray-300",
                  !readOnly && !isCurrent && "hover:bg-gray-50",
                  readOnly && "cursor-default",
                )}
              >
                {isDone && <span aria-hidden="true">&#10003; </span>}
                {WORK_STATUS_LABELS[stage]}
              </button>
            </li>
          );
        })}
      </ol>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          {WORK_STATUS_ASIDE.map((stage) => (
            <Button
              key={stage}
              size="sm"
              variant={stage === shown ? "danger" : "ghost"}
              disabled={update.isPending}
              onClick={() => void set(stage === shown ? "in_progress" : stage)}
            >
              {stage === shown ? "Resume work" : WORK_STATUS_LABELS[stage]}
            </Button>
          ))}
        </div>
      )}

      {shown === "on_hold" && (
        <p className="text-xs text-warning-600">
          This project is on hold. Pick a stage above, or resume, to continue.
        </p>
      )}
    </div>
  );
}
