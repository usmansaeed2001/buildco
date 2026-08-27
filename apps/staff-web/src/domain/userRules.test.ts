/**
 * Ported case-for-case from `apps/api/tests/unit/test_user_rules.py`.
 * When the Python changes, change both.
 */
import { describe, expect, it } from "vitest";
import {
  assignableRoles,
  canAssignRole,
  canRemoveUser,
  canReviewApprovalRequests,
  type UserSnapshot,
} from "./userRules";

const owner: UserSnapshot = { id: "u-owner", role: "owner" };
const otherOwner: UserSnapshot = { id: "u-owner-2", role: "owner" };
const admin: UserSnapshot = { id: "u-admin", role: "admin" };
const otherAdmin: UserSnapshot = { id: "u-admin-2", role: "admin" };
const member: UserSnapshot = { id: "u-member", role: "member" };

describe("canAssignRole", () => {
  it("lets an owner promote a member to admin", () => {
    expect(canAssignRole(owner, member, "admin").allowed).toBe(true);
  });

  it("lets an admin promote a member to admin", () => {
    expect(canAssignRole(admin, member, "admin").allowed).toBe(true);
  });

  it("refuses a member outright", () => {
    const decision = canAssignRole(member, admin, "member");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/Only owners and admins/);
  });

  it("refuses anyone changing their own role", () => {
    // The guard against an admin self-promoting, and against the last owner demoting
    // themselves and locking the team out.
    expect(canAssignRole(owner, owner, "member").allowed).toBe(false);
    expect(canAssignRole(admin, admin, "owner").reason).toMatch(/your own role/);
  });

  it("lets only an owner grant the owner role", () => {
    expect(canAssignRole(owner, member, "owner").allowed).toBe(true);
    expect(canAssignRole(admin, member, "owner").reason).toMatch(/Only owners can assign/);
  });

  it("lets only an owner change another owner's role", () => {
    expect(canAssignRole(owner, otherOwner, "admin").allowed).toBe(true);
    expect(canAssignRole(admin, otherOwner, "member").reason).toMatch(
      /Only owners can change another owner/,
    );
  });
});

describe("canRemoveUser", () => {
  it("lets an owner remove an admin or a member", () => {
    expect(canRemoveUser(owner, admin).allowed).toBe(true);
    expect(canRemoveUser(owner, member).allowed).toBe(true);
  });

  it("lets an admin remove only members", () => {
    expect(canRemoveUser(admin, member).allowed).toBe(true);
    expect(canRemoveUser(admin, otherAdmin).reason).toMatch(/only remove members/);
  });

  it("refuses removing an owner, whoever asks", () => {
    // Demote first, deliberately, and only an owner can do that — which makes locking
    // the team out of its own account a two-step, owner-only act.
    expect(canRemoveUser(owner, otherOwner).reason).toMatch(/owner cannot be removed/);
    expect(canRemoveUser(admin, owner).allowed).toBe(false);
  });

  it("refuses removing yourself", () => {
    expect(canRemoveUser(admin, admin).reason).toMatch(/remove yourself/);
  });

  it("refuses a member outright", () => {
    expect(canRemoveUser(member, member).allowed).toBe(false);
  });
});

describe("canReviewApprovalRequests", () => {
  it("admits owners and admins only", () => {
    expect(canReviewApprovalRequests(owner).allowed).toBe(true);
    expect(canReviewApprovalRequests(admin).allowed).toBe(true);
    expect(canReviewApprovalRequests(member).allowed).toBe(false);
  });
});

describe("assignableRoles", () => {
  it("offers an owner every role for someone else", () => {
    expect(assignableRoles(owner, member)).toEqual(["owner", "admin", "member"]);
  });

  it("withholds owner from an admin", () => {
    expect(assignableRoles(admin, member)).toEqual(["admin", "member"]);
  });

  it("offers nothing for yourself, so the control can be disabled rather than 403", () => {
    expect(assignableRoles(admin, admin)).toEqual([]);
  });

  it("offers an admin nothing for an existing owner", () => {
    expect(assignableRoles(admin, otherOwner)).toEqual([]);
  });
});
