"""Team-management permission rules."""

from __future__ import annotations

import uuid

import pytest

from app.models.enums import Role
from app.services.rules import user_rules
from app.services.rules.user_rules import UserSnapshot

OWNER = UserSnapshot(id=uuid.uuid4(), role=Role.OWNER)
ADMIN = UserSnapshot(id=uuid.uuid4(), role=Role.ADMIN)
MEMBER = UserSnapshot(id=uuid.uuid4(), role=Role.MEMBER)
OTHER_OWNER = UserSnapshot(id=uuid.uuid4(), role=Role.OWNER)
OTHER_ADMIN = UserSnapshot(id=uuid.uuid4(), role=Role.ADMIN)


# ── Role assignment ───────────────────────────────────────────────────────────


def test_an_owner_may_promote_a_member_to_admin():
    assert user_rules.can_assign_role(OWNER, MEMBER, Role.ADMIN)


def test_an_admin_may_promote_a_member_to_admin():
    assert user_rules.can_assign_role(ADMIN, MEMBER, Role.ADMIN)


def test_a_member_may_not_assign_roles():
    decision = user_rules.can_assign_role(MEMBER, OTHER_ADMIN, Role.MEMBER)

    assert not decision
    assert "owners and admins" in decision.reason


def test_nobody_may_change_their_own_role():
    """This is what stops an admin self-promoting to owner, and what stops the last
    owner demoting themselves and locking the team out."""
    assert not user_rules.can_assign_role(ADMIN, ADMIN, Role.OWNER)
    assert not user_rules.can_assign_role(OWNER, OWNER, Role.MEMBER)


def test_only_an_owner_may_grant_ownership():
    assert user_rules.can_assign_role(OWNER, MEMBER, Role.OWNER)

    decision = user_rules.can_assign_role(ADMIN, MEMBER, Role.OWNER)
    assert not decision
    assert "Only owners can assign the owner role" in decision.reason


def test_only_an_owner_may_change_another_owners_role():
    assert user_rules.can_assign_role(OWNER, OTHER_OWNER, Role.ADMIN)
    assert not user_rules.can_assign_role(ADMIN, OTHER_OWNER, Role.MEMBER)


# ── Removal ───────────────────────────────────────────────────────────────────


def test_an_owner_may_remove_an_admin():
    assert user_rules.can_remove_user(OWNER, OTHER_ADMIN)


def test_an_admin_may_remove_only_members():
    assert user_rules.can_remove_user(ADMIN, MEMBER)

    decision = user_rules.can_remove_user(ADMIN, OTHER_ADMIN)
    assert not decision
    assert "Admins can only remove members" in decision.reason


def test_the_owner_cannot_be_removed_through_the_api():
    """Demoting first is deliberate, and only an owner can do that — so locking the
    team out of its own account takes two owner-only steps, not one click."""
    decision = user_rules.can_remove_user(OWNER, OTHER_OWNER)

    assert not decision
    assert "owner cannot be removed" in decision.reason


def test_nobody_may_remove_themselves():
    assert not user_rules.can_remove_user(OWNER, OWNER)
    assert not user_rules.can_remove_user(ADMIN, ADMIN)


def test_a_member_may_not_remove_anyone():
    assert not user_rules.can_remove_user(MEMBER, OTHER_ADMIN)


# ── Access requests ───────────────────────────────────────────────────────────


def test_only_elevated_roles_review_access_requests():
    assert user_rules.can_review_approval_requests(OWNER)
    assert user_rules.can_review_approval_requests(ADMIN)
    assert not user_rules.can_review_approval_requests(MEMBER)


# ── First-user provisioning ───────────────────────────────────────────────────


@pytest.mark.parametrize(("is_first", "expected"), [(True, Role.OWNER), (False, Role.MEMBER)])
def test_the_first_user_ever_becomes_the_owner(is_first, expected):
    """Ported from the Supabase handle_new_user() trigger, which does not survive the
    move to Firebase Auth."""
    assert user_rules.initial_role_for_new_user(is_first_user=is_first) == expected
