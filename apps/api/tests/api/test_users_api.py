"""Team management, profiles, and the access-request workflow."""

from __future__ import annotations

import uuid

from app.models.enums import UserStatus
from app.models.profile import Profile

# ── Profiles ──────────────────────────────────────────────────────────────────


async def test_reading_your_own_profile(owner_client, owner):
    body = (await owner_client.get("/api/v1/users/me")).json()

    assert body["email"] == owner.email
    assert body["role"] == "owner"


async def test_updating_your_own_name_and_phone(owner_client):
    response = await owner_client.patch(
        "/api/v1/users/me", json={"full_name": "Olivia Renamed", "phone": "555-0100"}
    )

    assert response.json()["full_name"] == "Olivia Renamed"
    assert response.json()["phone"] == "555-0100"


async def test_you_cannot_promote_yourself_through_the_profile_endpoint(owner_client):
    """`role` is not a field on UserUpdate, so this is rejected at validation rather
    than silently dropped the way the legacy handler did."""
    response = await owner_client.patch("/api/v1/users/me", json={"role": "owner"})

    assert response.status_code == 422


async def test_every_authenticated_user_can_read_the_roster(member_client, owner):
    """Assignee names and avatars appear throughout the UI, so a member must be able
    to resolve them."""
    body = (await member_client.get("/api/v1/users")).json()

    assert owner.email in [u["email"] for u in body]


# ── Role assignment ───────────────────────────────────────────────────────────


async def test_an_owner_can_promote_a_member(owner_client, member):
    response = await owner_client.patch(f"/api/v1/users/{member.id}/role", json={"role": "admin"})

    assert response.status_code == 200
    assert response.json()["role"] == "admin"


async def test_a_member_cannot_assign_roles(member_client, admin):
    response = await member_client.patch(f"/api/v1/users/{admin.id}/role", json={"role": "member"})

    assert response.status_code == 403


async def test_an_admin_cannot_grant_ownership(client_as, admin, member):
    async with client_as(admin) as client:
        response = await client.patch(f"/api/v1/users/{member.id}/role", json={"role": "owner"})

    assert response.status_code == 403
    assert "Only owners can assign the owner role" in response.json()["error"]["message"]


async def test_nobody_can_change_their_own_role(owner_client, owner):
    response = await owner_client.patch(f"/api/v1/users/{owner.id}/role", json={"role": "member"})

    assert response.status_code == 403


async def test_an_invalid_role_is_rejected(owner_client, member):
    response = await owner_client.patch(
        f"/api/v1/users/{member.id}/role", json={"role": "superuser"}
    )

    assert response.status_code == 422


# ── Removal ───────────────────────────────────────────────────────────────────


async def test_an_owner_can_remove_a_member(owner_client, member, db):
    response = await owner_client.post(f"/api/v1/users/{member.id}/ban")

    assert response.status_code == 200
    assert response.json()["status"] == "banned"

    refreshed = await db.get(Profile, member.id)
    await db.refresh(refreshed)
    assert refreshed.removed_at is not None


async def test_the_owner_cannot_be_removed(client_as, admin, owner):
    async with client_as(admin) as client:
        response = await client.post(f"/api/v1/users/{owner.id}/ban")

    assert response.status_code == 403
    assert "owner cannot be removed" in response.json()["error"]["message"]


async def test_an_admin_cannot_remove_another_admin(client_as, admin, session_factory):
    async with session_factory() as session:
        other = Profile(
            id=uuid.uuid4(),
            email="other-admin@buildco.example.com",
            full_name="Other Admin",
            role="admin",
            status=UserStatus.ACTIVE.value,
        )
        session.add(other)
        await session.commit()

    async with client_as(admin) as client:
        response = await client.post(f"/api/v1/users/{other.id}/ban")

    assert response.status_code == 403


async def test_a_member_cannot_remove_anyone(member_client, admin):
    response = await member_client.post(f"/api/v1/users/{admin.id}/ban")

    assert response.status_code == 403


async def test_removing_a_member_notifies_the_admins(owner_client, member, notifications):
    await owner_client.post(f"/api/v1/users/{member.id}/ban")

    assert any("removed" in s.lower() for s in notifications.subjects())


# ── Account status and access requests ────────────────────────────────────────


async def test_account_status_is_readable_without_authentication(anon_client, owner):
    response = await anon_client.get(f"/api/v1/auth/status?email={owner.email}")

    assert response.status_code == 200
    assert response.json()["status"] == "active"


async def test_an_unknown_address_reports_not_found(anon_client):
    response = await anon_client.get("/api/v1/auth/status?email=nobody@buildco.example.com")

    assert response.json()["status"] == "not_found"


async def test_a_removed_user_signing_in_files_one_access_request(
    owner_client, anon_client, member, notifications
):
    await owner_client.post(f"/api/v1/users/{member.id}/ban")
    notifications.sent.clear()

    first = await anon_client.get(f"/api/v1/auth/status?email={member.email}")
    second = await anon_client.get(f"/api/v1/auth/status?email={member.email}")

    assert first.json() == {"status": "banned", "request_filed": True}
    # A second attempt must not queue a duplicate for the admins to wade through.
    assert second.json() == {"status": "banned", "request_filed": False}

    pending = (await owner_client.get("/api/v1/approval-requests")).json()
    assert len(pending) == 1


async def test_the_access_attempt_notifies_the_admins(
    owner_client, anon_client, member, notifications
):
    await owner_client.post(f"/api/v1/users/{member.id}/ban")
    notifications.sent.clear()

    await anon_client.get(f"/api/v1/auth/status?email={member.email}")

    assert any("access attempt" in s.lower() for s in notifications.subjects())


async def test_approving_a_request_restores_access(owner_client, anon_client, member, db):
    await owner_client.post(f"/api/v1/users/{member.id}/ban")
    await anon_client.get(f"/api/v1/auth/status?email={member.email}")
    request_id = (await owner_client.get("/api/v1/approval-requests")).json()[0]["id"]

    response = await owner_client.post(f"/api/v1/approval-requests/{request_id}/approve")

    assert response.status_code == 200
    restored = await db.get(Profile, member.id)
    await db.refresh(restored)
    assert restored.status == "active"
    assert restored.removed_at is None


async def test_denying_a_request_leaves_the_user_removed(owner_client, anon_client, member, db):
    await owner_client.post(f"/api/v1/users/{member.id}/ban")
    await anon_client.get(f"/api/v1/auth/status?email={member.email}")
    request_id = (await owner_client.get("/api/v1/approval-requests")).json()[0]["id"]

    await owner_client.post(f"/api/v1/approval-requests/{request_id}/deny")

    still_banned = await db.get(Profile, member.id)
    await db.refresh(still_banned)
    assert still_banned.status == "banned"


async def test_a_request_cannot_be_reviewed_twice(owner_client, anon_client, member):
    await owner_client.post(f"/api/v1/users/{member.id}/ban")
    await anon_client.get(f"/api/v1/auth/status?email={member.email}")
    request_id = (await owner_client.get("/api/v1/approval-requests")).json()[0]["id"]

    await owner_client.post(f"/api/v1/approval-requests/{request_id}/approve")
    second = await owner_client.post(f"/api/v1/approval-requests/{request_id}/deny")

    assert second.status_code == 404


async def test_a_member_cannot_see_access_requests(member_client):
    response = await member_client.get("/api/v1/approval-requests")

    assert response.status_code == 403


# ── Error envelope ────────────────────────────────────────────────────────────


async def test_errors_share_one_envelope(owner_client):
    response = await owner_client.get(f"/api/v1/estimates/{uuid.uuid4()}")
    body = response.json()

    assert response.status_code == 404
    assert set(body) == {"error"}
    assert body["error"]["code"] == "not_found"
    assert isinstance(body["error"]["message"], str)


async def test_an_unknown_route_uses_the_same_envelope(owner_client):
    body = (await owner_client.get("/api/v1/does-not-exist")).json()

    assert body["error"]["code"] == "not_found"


async def test_every_response_carries_a_request_id(owner_client):
    response = await owner_client.get("/api/v1/users/me")

    assert response.headers["X-Request-ID"]
