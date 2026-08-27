/**
 * Ported case-for-case from `apps/api/tests/unit/test_project_rules.py`.
 *
 * When the Python changes, change both. The derivation is the most business-visible
 * logic in the system, and the two implementations disagreeing means the screen tells
 * someone their project is closed while the database says otherwise.
 */
import { describe, expect, it } from "vitest";
import type { ProjectStatus, WorkStatus } from "./enums";
import matrix from "./projectRules.matrix.json";
import {
  allMilestonesPaid,
  bothClosingFormsSubmitted,
  canAccess,
  canChangeWorkStatus,
  canDeleteMilestone,
  canDeleteProject,
  canEditProject,
  canManageMilestones,
  canSetProjectStatus,
  deriveProjectState,
  workStatusIndex,
  WORK_STATUS_SEQUENCE,
  type ActorSnapshot,
  type ProjectSnapshot,
} from "./projectRules";

function project(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    workStatus: "in_progress",
    status: "active",
    hasClosingForm1: false,
    hasClosingForm2: false,
    milestones: [],
    assignedTo: null,
    ...overrides,
  };
}

const owner: ActorSnapshot = { id: "u-owner", role: "owner" };
const admin: ActorSnapshot = { id: "u-admin", role: "admin" };
const member: ActorSnapshot = { id: "u-member", role: "member" };

describe("deriveProjectState", () => {
  it("completes the work when both closing forms are in", () => {
    const state = deriveProjectState(
      project({ hasClosingForm1: true, hasClosingForm2: true }),
    );
    expect(state.workStatus).toBe("completed");
  });

  it("does not complete the work on one closing form alone", () => {
    const state = deriveProjectState(project({ hasClosingForm1: true }));
    expect(state.workStatus).toBe("in_progress");
    expect(state.status).toBe("active");
  });

  it("closes a project once completed work is fully paid", () => {
    const state = deriveProjectState(
      project({ workStatus: "completed", milestones: [{ paid: true }, { paid: true }] }),
    );
    expect(state.status).toBe("closed");
  });

  it("treats a project with no milestones as fully paid", () => {
    // A job with no payment schedule recorded should not be held open for ever
    // waiting on payments nobody scheduled.
    const state = deriveProjectState(project({ workStatus: "completed", milestones: [] }));
    expect(state.status).toBe("closed");
    expect(state.reason).toMatch(/no payment milestones were scheduled/);
  });

  it("completes and closes in a single evaluation", () => {
    const state = deriveProjectState(
      project({
        workStatus: "in_progress",
        hasClosingForm1: true,
        hasClosingForm2: true,
        milestones: [{ paid: true }],
      }),
    );
    expect(state.workStatus).toBe("completed");
    expect(state.status).toBe("closed");
  });

  it("holds completed work with an outstanding payment at pending_payment", () => {
    const state = deriveProjectState(
      project({ workStatus: "completed", milestones: [{ paid: true }, { paid: false }] }),
    );
    expect(state.status).toBe("pending_payment");
  });

  it("counts the outstanding milestones in its explanation", () => {
    const state = deriveProjectState(
      project({
        workStatus: "completed",
        milestones: [{ paid: false }, { paid: false }, { paid: true }],
      }),
    );
    expect(state.reason).toMatch(/2 milestones are unpaid/);
  });

  it("uses the singular for one outstanding milestone", () => {
    const state = deriveProjectState(
      project({ workStatus: "completed", milestones: [{ paid: false }] }),
    );
    expect(state.reason).toMatch(/1 milestone is unpaid/);
  });

  it("completes the work but does not close when payment is outstanding", () => {
    const state = deriveProjectState(
      project({
        hasClosingForm1: true,
        hasClosingForm2: true,
        milestones: [{ paid: false }],
      }),
    );
    expect(state.workStatus).toBe("completed");
    expect(state.status).toBe("pending_payment");
  });

  describe("reversibility — a deliberate change from the legacy behaviour", () => {
    it("reopens a closed project when a payment is unmarked", () => {
      // The old code only ever moved a project forward: a mistaken "paid" click closed
      // it permanently, with no path back.
      const state = deriveProjectState(
        project({
          workStatus: "completed",
          status: "closed",
          milestones: [{ paid: true }, { paid: false }],
        }),
      );
      expect(state.status).toBe("pending_payment");
    });

    it("returns a closed project to active when work status is reverted", () => {
      const state = deriveProjectState(
        project({ workStatus: "in_progress", status: "closed", milestones: [{ paid: true }] }),
      );
      expect(state.status).toBe("active");
    });
  });

  describe("cancellation is final", () => {
    const cases: WorkStatus[] = ["contract_sent", "in_progress", "completed"];

    it.each(cases)("is never overridden from work status %s", (workStatus) => {
      const state = deriveProjectState(
        project({
          workStatus,
          status: "cancelled",
          hasClosingForm1: true,
          hasClosingForm2: true,
          milestones: [{ paid: true }],
        }),
      );
      expect(state.status).toBe("cancelled");
      // Not even the closing-form rule applies.
      expect(state.workStatus).toBe(workStatus);
    });
  });

  describe("idempotence", () => {
    const cases: [WorkStatus, ProjectStatus, { paid: boolean }[]][] = [
      ["in_progress", "active", []],
      ["completed", "closed", [{ paid: true }]],
      ["completed", "pending_payment", [{ paid: false }]],
      ["on_hold", "active", [{ paid: false }]],
    ];

    it.each(cases)(
      "leaves an already-correct project unchanged (%s / %s)",
      (workStatus, status, milestones) => {
        const snapshot = project({ workStatus, status, milestones });
        const once = deriveProjectState(snapshot);

        expect(once.workStatus).toBe(workStatus);
        expect(once.status).toBe(status);
      },
    );

    it("is stable when applied twice", () => {
      const first = deriveProjectState(
        project({ hasClosingForm1: true, hasClosingForm2: true, milestones: [{ paid: false }] }),
      );
      const second = deriveProjectState(
        project({
          workStatus: first.workStatus,
          status: first.status,
          hasClosingForm1: true,
          hasClosingForm2: true,
          milestones: [{ paid: false }],
        }),
      );

      expect(second.workStatus).toBe(first.workStatus);
      expect(second.status).toBe(first.status);
    });
  });
});

/**
 * The whole decision table, generated from the Python engine itself.
 *
 * `projectRules.matrix.json` is generated, not written. Regenerate it whenever
 * `project_rules.evaluate` changes:
 *
 *     cd apps/api
 *     uv run python scripts/export_project_rules_matrix.py  *         > ../staff-web/src/domain/projectRules.matrix.json
 *
 * A hand-written port can look right and still disagree in a corner nobody thought to
 * test. This cannot: it is every combination of work status, project status,
 * closing-form pair and milestone shape, run through the real engine. A failure here is
 * the port drifting, not a flaky test.
 */
describe("the full rule matrix, against the Python engine's own output", () => {
  const MILESTONES: Record<string, { paid: boolean }[]> = {
    none: [],
    all_paid: [{ paid: true }],
    one_unpaid: [{ paid: true }, { paid: false }],
  };

  it(`agrees on all ${matrix.length} cases`, () => {
    const disagreements: string[] = [];

    for (const row of matrix) {
      const state = deriveProjectState({
        workStatus: row.workStatus as WorkStatus,
        status: row.status as ProjectStatus,
        hasClosingForm1: row.hasClosingForm1,
        hasClosingForm2: row.hasClosingForm2,
        milestones: MILESTONES[row.milestones]!,
        assignedTo: null,
      });

      if (state.workStatus !== row.expectedWorkStatus || state.status !== row.expectedStatus) {
        disagreements.push(
          `${row.workStatus}/${row.status}/forms=${Number(row.hasClosingForm1)}${Number(
            row.hasClosingForm2,
          )}/${row.milestones}: ` +
            `expected ${row.expectedWorkStatus}+${row.expectedStatus}, ` +
            `got ${state.workStatus}+${state.status}`,
        );
      }
    }

    expect(disagreements).toEqual([]);
  });
});

describe("snapshot helpers", () => {
  it("requires both forms", () => {
    expect(bothClosingFormsSubmitted(project({ hasClosingForm1: true }))).toBe(false);
    expect(
      bothClosingFormsSubmitted(project({ hasClosingForm1: true, hasClosingForm2: true })),
    ).toBe(true);
  });

  it("counts an empty milestone list as paid", () => {
    expect(allMilestonesPaid(project({ milestones: [] }))).toBe(true);
    expect(allMilestonesPaid(project({ milestones: [{ paid: false }] }))).toBe(false);
  });
});

describe("access", () => {
  it("lets elevated roles see any project", () => {
    expect(canAccess(owner, project())).toBe(true);
    expect(canAccess(admin, project())).toBe(true);
  });

  it("hides an unassigned project from a member", () => {
    // The API returns 404, not 403 — the project's existence is itself privileged.
    expect(canAccess(member, project({ assignedTo: null }))).toBe(false);
    expect(canAccess(member, project({ assignedTo: "someone-else" }))).toBe(false);
  });

  it("shows a member the project they are assigned to", () => {
    expect(canAccess(member, project({ assignedTo: member.id }))).toBe(true);
  });
});

describe("permissions", () => {
  it("restricts editing, cancelling and deleting to elevated roles", () => {
    for (const predicate of [canEditProject, canDeleteProject, canSetProjectStatus]) {
      expect(predicate(owner)).toBe(true);
      expect(predicate(admin)).toBe(true);
      expect(predicate(member)).toBe(false);
    }
  });

  it("lets an assigned member advance the work", () => {
    // Requiring an admin to record the crew's own progress is how a status board
    // stops matching reality.
    const assigned = project({ assignedTo: member.id });
    expect(canChangeWorkStatus(member, assigned)).toBe(true);
    expect(canChangeWorkStatus(member, project({ assignedTo: "other" }))).toBe(false);
  });

  it("lets an assigned member add and pay milestones but not delete them", () => {
    const assigned = project({ assignedTo: member.id });
    expect(canManageMilestones(member, assigned)).toBe(true);
    expect(canDeleteMilestone(member)).toBe(false);
    expect(canDeleteMilestone(admin)).toBe(true);
  });
});

describe("work status sequence", () => {
  it("keeps on_hold out of the stepper", () => {
    // It is entered from anywhere and left back to wherever you were — not a stage
    // every project passes through.
    expect(WORK_STATUS_SEQUENCE).not.toContain("on_hold");
    expect(workStatusIndex("on_hold")).toBe(-1);
  });

  it("orders the stages as the legacy stepper did", () => {
    expect(WORK_STATUS_SEQUENCE).toEqual([
      "contract_sent",
      "contract_not_signed",
      "contract_signed",
      "start_date",
      "in_progress",
      "completed",
    ]);
  });
});
