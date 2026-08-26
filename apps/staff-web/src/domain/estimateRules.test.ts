/**
 * Ported from `apps/api/tests/unit/test_estimate_rules.py`.
 *
 * These pin the UI's view of permissions to the backend's. When they disagree, the
 * symptom is a button that appears and then fails with a 403 — or, worse, an action a
 * user is entitled to that the UI silently hides.
 */
import { describe, expect, it } from "vitest";
import {
  availableTransitions,
  canBeSubmitted,
  canEdit,
  canPermanentlyDelete,
  canRestore,
  canSoftDelete,
  canView,
  isTransitionAllowed,
  SUBMITTABLE_FROM,
  TRANSITIONS,
  type ActorSnapshot,
  type EstimateSnapshot,
  type TransitionAction,
} from "./estimateRules";
import { ESTIMATE_STATUSES, type EstimateStatus, type Role } from "./enums";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";

const actor = (role: Role, id = OWNER_ID): ActorSnapshot => ({ id, role });

const estimate = (
  overrides: Partial<EstimateSnapshot> = {},
): EstimateSnapshot => ({
  status: "active",
  createdBy: OWNER_ID,
  isTrashed: false,
  ...overrides,
});

describe("visibility", () => {
  it.each(["owner", "admin"] as const)("%s sees every estimate", (role) => {
    expect(canView(actor(role, OTHER_ID), estimate())).toBe(true);
  });

  it("a member sees only their own", () => {
    const member = actor("member", MEMBER_ID);

    expect(canView(member, estimate({ createdBy: MEMBER_ID }))).toBe(true);
    expect(canView(member, estimate({ createdBy: OTHER_ID }))).toBe(false);
  });
});

describe("editing", () => {
  it("a locked estimate is editable only by the owner", () => {
    const locked = estimate({ status: "locked" });

    expect(canEdit(actor("owner"), locked)).toBe(true);
    expect(canEdit(actor("admin", OTHER_ID), locked)).toBe(false);
    expect(canEdit(actor("member", MEMBER_ID), locked)).toBe(false);
  });

  it("locking outranks authorship", () => {
    // The member wrote it, and still cannot edit it once locked.
    const locked = estimate({ status: "locked", createdBy: MEMBER_ID });

    expect(canEdit(actor("member", MEMBER_ID), locked)).toBe(false);
  });

  it("a member can edit only their own", () => {
    const member = actor("member", MEMBER_ID);

    expect(canEdit(member, estimate({ createdBy: MEMBER_ID }))).toBe(true);
    expect(canEdit(member, estimate({ createdBy: OTHER_ID }))).toBe(false);
  });

  it("does not freeze editing on non-active statuses", () => {
    // The legacy UI gated editing on status === "active". The backend never did.
    const submitted = estimate({ status: "submitted", createdBy: MEMBER_ID });

    expect(canEdit(actor("member", MEMBER_ID), submitted)).toBe(true);
  });
});

describe("deletion", () => {
  it("authors and elevated roles can trash an estimate", () => {
    expect(canSoftDelete(actor("admin", OTHER_ID), estimate())).toBe(true);
    expect(canSoftDelete(actor("member", MEMBER_ID), estimate({ createdBy: MEMBER_ID }))).toBe(
      true,
    );
    expect(canSoftDelete(actor("member", MEMBER_ID), estimate({ createdBy: OTHER_ID }))).toBe(
      false,
    );
  });

  it("never offers permanent deletion to a member, even for their own", () => {
    expect(canPermanentlyDelete(actor("member", MEMBER_ID))).toBe(false);
    expect(canPermanentlyDelete(actor("admin"))).toBe(true);
    expect(canPermanentlyDelete(actor("owner"))).toBe(true);
  });

  it("restores from the trash only for elevated roles", () => {
    expect(canRestore(actor("member", MEMBER_ID))).toBe(false);
    expect(canRestore(actor("admin"))).toBe(true);
  });
});

describe("transitions", () => {
  it.each([
    ["archive", "archived"],
    ["unarchive", "active"],
    ["lock", "locked"],
    ["unlock", "active"],
    ["recall", "active"],
    ["resubmit_ready", "active"],
    ["admin_approve", "approved"],
  ] as [TransitionAction, EstimateStatus][])("%s moves to %s", (action, target) => {
    expect(TRANSITIONS[action].target).toBe(target);
  });

  it.each(["lock", "unlock"] as const)("only the owner may %s", (action) => {
    expect(isTransitionAllowed(action, actor("owner"))).toBe(true);
    expect(isTransitionAllowed(action, actor("admin"))).toBe(false);
    expect(isTransitionAllowed(action, actor("member"))).toBe(false);
  });

  it.each(["archive", "unarchive", "admin_approve"] as const)(
    "members cannot %s",
    (action) => {
      expect(isTransitionAllowed(action, actor("member"))).toBe(false);
      expect(isTransitionAllowed(action, actor("admin"))).toBe(true);
      expect(isTransitionAllowed(action, actor("owner"))).toBe(true);
    },
  );

  it.each(["recall", "resubmit_ready"] as const)("any role may %s", (action) => {
    for (const role of ["owner", "admin", "member"] as const) {
      expect(isTransitionAllowed(action, actor(role))).toBe(true);
    }
  });

  it.each(["recall", "resubmit_ready"] as const)("%s invalidates the reviewer link", (action) => {
    expect(TRANSITIONS[action].clearsApprovalToken).toBe(true);
  });

  it.each(["archive", "unarchive", "lock", "unlock", "admin_approve"] as const)(
    "%s leaves the approval token alone",
    (action) => {
      expect(TRANSITIONS[action].clearsApprovalToken).toBe(false);
    },
  );
});

describe("availableTransitions", () => {
  it("offers nothing for a trashed estimate", () => {
    expect(availableTransitions(actor("owner"), estimate({ isTrashed: true }))).toEqual([]);
  });

  it("offers recall on a submitted estimate to its member author", () => {
    const actions = availableTransitions(
      actor("member", MEMBER_ID),
      estimate({ status: "submitted", createdBy: MEMBER_ID }),
    ).map((t) => t.action);

    expect(actions).toContain("recall");
    // admin_approve is elevated-only and must not be offered here.
    expect(actions).not.toContain("admin_approve");
  });

  it("never offers a transition the actor's role cannot perform", () => {
    for (const status of ESTIMATE_STATUSES) {
      for (const role of ["owner", "admin", "member"] as const) {
        const person = actor(role, MEMBER_ID);
        for (const transition of availableTransitions(person, estimate({ status }))) {
          expect(transition.allowedRoles).toContain(role);
        }
      }
    }
  });
});

describe("submittability", () => {
  it.each(SUBMITTABLE_FROM)("%s can be sent for review", (status) => {
    expect(canBeSubmitted(estimate({ status }))).toBe(true);
  });

  it.each(["submitted", "approved", "archived", "locked"] as const)(
    "%s cannot be sent for review",
    (status) => {
      expect(canBeSubmitted(estimate({ status }))).toBe(false);
    },
  );
});
