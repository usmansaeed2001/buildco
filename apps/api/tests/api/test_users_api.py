"""Team management, profiles, and the access-request workflow."""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

from sqlalchemy import select

from app.models.enums import UserStatus
from app.models.profile import Profile
from app.services import user_service
from app.services.integrations import firebase
from app.services.integrations.firebase import VerifiedIdentity

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


# ── Avatars ───────────────────────────────────────────────────────────────────


async def test_an_avatar_upload_url_is_unavailable_without_a_bucket(owner_client):
    response = await owner_client.post(
        "/api/v1/users/me/avatar-upload-url",
        json={"file_name": "me.png", "content_type": "image/png"},
    )

    assert response.status_code == 503


async def test_an_avatar_url_is_recorded_on_the_profile(owner_client):
    url = "https://storage.googleapis.com/buildco-avatars/abc/avatar.png"

    response = await owner_client.put("/api/v1/users/me/avatar", json={"avatar_url": url})

    assert response.status_code == 200
    assert response.json()["avatar_url"] == url
    assert (await owner_client.get("/api/v1/users/me")).json()["avatar_url"] == url


# ── Session provisioning ──────────────────────────────────────────────────────


async def test_the_first_user_to_establish_a_session_becomes_the_owner(anon_client):
    """The provisioning rule that replaces Supabase's ``handle_new_user`` trigger.

    Exercised over HTTP here because every other test bypasses the route entirely via
    the ``get_current_user`` override, so the rule was only ever unit-tested.
    """
    response = await anon_client.post(
        "/api/v1/auth/session", headers={"Authorization": "Bearer any-token"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["created"] is True
    assert body["user"]["role"] == "owner"


async def test_establishing_a_session_twice_provisions_only_once(anon_client):
    first = await anon_client.post(
        "/api/v1/auth/session", headers={"Authorization": "Bearer any-token"}
    )
    second = await anon_client.post(
        "/api/v1/auth/session", headers={"Authorization": "Bearer any-token"}
    )

    assert first.json()["created"] is True
    assert second.json()["created"] is False
    assert second.json()["user"]["id"] == first.json()["user"]["id"]


async def test_a_session_cannot_be_established_without_a_token(anon_client):
    assert (await anon_client.post("/api/v1/auth/session")).status_code == 401


async def test_provisioning_accepts_an_over_long_google_photo_url(db):
    """A signed Google photo URL has no length limit we control.

    ``avatar_url`` was ``varchar(1000)``; the ``a-/ALV-...`` form regularly runs past
    that, and because provisioning copies ``identity.picture`` straight onto the new
    row, the whole first sign-in failed on the INSERT rather than just losing the
    picture. The column is now unbounded text.
    """
    picture = "https://lh3.googleusercontent.com/a-/ALV-" + "x" * 1200

    resolved = await user_service.resolve_profile(
        db,
        VerifiedIdentity(
            uid="uid-long-photo",
            email="long.photo@buildcogrp.com",
            email_verified=True,
            name="Long Photo",
            picture=picture,
        ),
    )

    assert resolved.created is True
    assert resolved.profile.avatar_url == picture


# ── Invitations ───────────────────────────────────────────────────────────────

INVITEE = "new.hire@buildco.example.com"
BEARER = {"Authorization": "Bearer any-token"}


async def invite(client, **overrides):
    return await client.post(
        "/api/v1/users/invite", json={"email": INVITEE, "role": "member", **overrides}
    )


def emailed_link(notifications) -> str:
    """The join link from the most recent invitation email."""
    sent = [s for s in notifications.sent if s.context.get("cta_label") == "Join BuildCo"]
    return sent[-1].context["cta_url"]


def emailed_token(notifications) -> str:
    """The only place an invitation token exists in the clear."""
    return parse_qs(urlparse(emailed_link(notifications)).query)["invite"][0]


async def stored(session_factory, email: str = INVITEE) -> Profile | None:
    """Read a profile in its own session, so no test sees a stale copy."""
    async with session_factory() as session:
        return await session.scalar(select(Profile).where(Profile.email == email))


def sign_in_as(monkeypatch, *, email: str = INVITEE, verified: bool, uid: str = "uid-new-hire"):
    """Make the next token verify as this identity.

    The fake provider returns one fixed, *verified* dev owner. Invitations turn on
    exactly the two things that fixes — whose address it is, and whether the provider
    vouches for it — so the cached provider instance the routers share is patched.
    """

    async def verify(token: str) -> VerifiedIdentity:
        return VerifiedIdentity(uid=uid, email=email, email_verified=verified, name="Nia Hire")

    monkeypatch.setattr(firebase.get_auth_provider(), "verify_id_token", verify)


async def test_an_owner_can_add_someone_with_a_role(owner_client):
    response = await invite(owner_client, role="admin", full_name="Nia Hire")

    assert response.status_code == 201
    body = response.json()
    assert body["email"] == INVITEE
    assert body["role"] == "admin"
    assert body["invite_pending"] is True
    assert body["firebase_uid"] is None


async def test_an_invited_person_is_on_the_roster_before_they_join(owner_client):
    """Deliberate: work can be assigned to them, and meetings sent, before first sign-in."""
    await invite(owner_client)

    roster = (await owner_client.get("/api/v1/users")).json()

    assert [(u["status"], u["invite_pending"]) for u in roster if u["email"] == INVITEE] == [
        ("active", True)
    ]


async def test_the_invitation_is_emailed_with_a_join_link(owner_client, owner, notifications):
    await invite(owner_client, role="admin")

    sent = notifications.sent[-1]
    link = urlparse(emailed_link(notifications))
    assert sent.recipient == INVITEE
    assert "invited" in sent.subject.lower()
    assert f"{link.scheme}://{link.netloc}{link.path}" == "http://testserver/signup"
    assert parse_qs(link.query)["email"] == [INVITEE]
    assert ("Role", "Admin") in sent.context["rows"]
    assert ("Invited by", owner.display_name) in sent.context["rows"]


async def test_only_a_hash_of_the_token_is_stored(owner_client, notifications, session_factory):
    """The token is a credential for a role. Reading the table must not be enough to use it."""
    await invite(owner_client)

    token = emailed_token(notifications)
    profile = await stored(session_factory)

    assert profile.invite_token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert token not in (profile.invite_token_hash or "")


async def test_a_member_cannot_add_people(member_client):
    assert (await invite(member_client)).status_code == 403


async def test_an_admin_cannot_invite_an_owner(client_as, admin):
    """Otherwise an invitation would be a way round "only owners grant ownership"."""
    async with client_as(admin) as client:
        response = await invite(client, role="owner")

    assert response.status_code == 403
    assert "Only owners can invite another owner" in response.json()["error"]["message"]


async def test_an_admin_can_invite_another_admin(client_as, admin):
    async with client_as(admin) as client:
        response = await invite(client, role="admin")

    assert response.status_code == 201


async def test_someone_already_on_the_team_cannot_be_invited(owner_client, session_factory):
    async with session_factory() as session:
        session.add(
            Profile(
                id=uuid.uuid4(),
                firebase_uid="fb-existing",
                email=INVITEE,
                role="member",
                status=UserStatus.ACTIVE.value,
            )
        )
        await session.commit()

    # Upper-cased: the same person must not be invitable under a different casing.
    response = await invite(owner_client, email=INVITEE.upper())

    assert response.status_code == 409
    assert "already on the team" in response.json()["error"]["message"]


async def test_inviting_the_same_address_twice_points_at_resend(owner_client, notifications):
    await invite(owner_client)
    notifications.sent.clear()

    response = await invite(owner_client)

    assert response.status_code == 409
    assert "Resend the invitation" in response.json()["error"]["message"]
    assert notifications.sent == []


async def test_a_malformed_address_cannot_be_invited(owner_client):
    assert (await invite(owner_client, email="not-an-address")).status_code == 422


# Accepting ───────────────────────────────────────────────────────────────────


async def test_following_the_link_joins_with_the_invited_role(
    owner_client, anon_client, notifications, monkeypatch, session_factory
):
    """A password sign-up is unverified, so the emailed token is what proves the address."""
    await invite(owner_client, role="admin")
    token = emailed_token(notifications)
    sign_in_as(monkeypatch, verified=False)

    response = await anon_client.post(
        "/api/v1/auth/session", headers=BEARER, json={"invite_token": token}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["linked"] is True
    assert body["created"] is False
    assert body["user"]["role"] == "admin"
    assert body["user"]["invite_pending"] is False
    # Left blank by the admin, so it is taken from the sign-in.
    assert body["user"]["full_name"] == "Nia Hire"

    profile = await stored(session_factory)
    assert profile.firebase_uid == "uid-new-hire"
    # Cleared on acceptance: that is what makes the link single-use.
    assert profile.invite_token_hash is None


async def test_an_invitation_cannot_be_claimed_by_signing_up_with_the_address(
    owner_client, anon_client, monkeypatch, session_factory
):
    """The reason the token exists.

    Firebase creates a password account for any address without confirming it. Linking
    a pending invitation on the address alone would hand its role to whoever signed up
    with it first.
    """
    await invite(owner_client, role="admin")
    sign_in_as(monkeypatch, verified=False, uid="uid-squatter")

    response = await anon_client.post("/api/v1/auth/session", headers=BEARER)

    assert response.status_code == 403
    assert "invitation email" in response.json()["error"]["message"]
    profile = await stored(session_factory)
    assert profile.firebase_uid is None
    assert profile.invite_pending is True


async def test_a_wrong_token_does_not_accept_the_invitation(
    owner_client, anon_client, monkeypatch, session_factory
):
    await invite(owner_client)
    sign_in_as(monkeypatch, verified=False)

    response = await anon_client.post(
        "/api/v1/auth/session", headers=BEARER, json={"invite_token": "not-the-token"}
    )

    assert response.status_code == 403
    assert (await stored(session_factory)).firebase_uid is None


async def test_a_google_sign_in_joins_without_the_link(owner_client, anon_client, monkeypatch):
    """The provider vouches for the address, which is the same proof the token gives."""
    await invite(owner_client, role="admin")
    sign_in_as(monkeypatch, verified=True)

    response = await anon_client.post("/api/v1/auth/session", headers=BEARER)

    assert response.status_code == 200
    assert response.json()["user"]["role"] == "admin"
    assert response.json()["user"]["invite_pending"] is False


async def test_an_expired_link_is_refused_and_says_so(
    owner_client, anon_client, notifications, monkeypatch, session_factory
):
    await invite(owner_client)
    token = emailed_token(notifications)
    async with session_factory() as session:
        profile = await session.scalar(select(Profile).where(Profile.email == INVITEE))
        profile.invited_at = datetime.now(UTC) - timedelta(days=8)
        await session.commit()
    sign_in_as(monkeypatch, verified=False)

    response = await anon_client.post(
        "/api/v1/auth/session", headers=BEARER, json={"invite_token": token}
    )

    assert response.status_code == 403
    assert "expired" in response.json()["error"]["message"]


async def test_a_migrated_user_still_links_by_address_alone(db):
    """Invitations must not change how a pre-existing profile with no uid signs in.

    A user carried over from Supabase has no invitation, so nothing asks them for a
    token — even though their first Firebase sign-in may well be unverified.
    """
    db.add(
        Profile(
            id=uuid.uuid4(),
            email="veteran@buildco.example.com",
            full_name="Vera Veteran",
            role="admin",
            status=UserStatus.ACTIVE.value,
        )
    )
    await db.flush()

    resolved = await user_service.resolve_profile(
        db,
        VerifiedIdentity(uid="uid-veteran", email="veteran@buildco.example.com"),
    )

    assert resolved.linked is True
    assert resolved.accepted_invite is False
    assert resolved.profile.firebase_uid == "uid-veteran"


# Resending and revoking ──────────────────────────────────────────────────────


async def test_resending_replaces_the_link(owner_client, anon_client, notifications, monkeypatch):
    """If the first email went astray, the link in it must stop working."""
    invited = (await invite(owner_client)).json()
    first = emailed_token(notifications)

    response = await owner_client.post(f"/api/v1/users/{invited['id']}/invite/resend")
    second = emailed_token(notifications)

    assert response.status_code == 200
    assert second != first
    assert [s.recipient for s in notifications.sent][-2:] == [INVITEE, INVITEE]

    sign_in_as(monkeypatch, verified=False)
    stale = await anon_client.post(
        "/api/v1/auth/session", headers=BEARER, json={"invite_token": first}
    )
    fresh = await anon_client.post(
        "/api/v1/auth/session", headers=BEARER, json={"invite_token": second}
    )
    assert (stale.status_code, fresh.status_code) == (403, 200)


async def test_there_is_nothing_to_resend_once_they_have_joined(owner_client, member):
    response = await owner_client.post(f"/api/v1/users/{member.id}/invite/resend")

    assert response.status_code == 409


async def test_a_member_cannot_resend_an_invitation(owner_client, member_client):
    invited = (await invite(owner_client)).json()

    response = await member_client.post(f"/api/v1/users/{invited['id']}/invite/resend")

    assert response.status_code == 403


async def test_revoking_an_invitation_removes_it_entirely(owner_client, session_factory):
    """Deleted, not banned — nobody was ever behind it, and a typo must be correctable."""
    invited = (await invite(owner_client)).json()

    response = await owner_client.delete(f"/api/v1/users/{invited['id']}/invite")

    assert response.status_code == 200
    assert await stored(session_factory) is None
    # The address is free again.
    assert (await invite(owner_client)).status_code == 201


async def test_a_revoked_link_no_longer_joins_with_the_invited_role(
    owner_client, anon_client, notifications, monkeypatch
):
    """With the invitation gone, the link is just a sign-up link: an ordinary member."""
    invited = (await invite(owner_client, role="admin")).json()
    token = emailed_token(notifications)
    await owner_client.delete(f"/api/v1/users/{invited['id']}/invite")
    sign_in_as(monkeypatch, verified=False)

    response = await anon_client.post(
        "/api/v1/auth/session", headers=BEARER, json={"invite_token": token}
    )

    assert response.json()["user"]["role"] == "member"


async def test_someone_who_has_joined_cannot_be_revoked(owner_client, member, session_factory):
    """They are a member with history now. Removal goes through the ban, which is
    reversible and leaves their work attributed."""
    response = await owner_client.delete(f"/api/v1/users/{member.id}/invite")

    assert response.status_code == 409
    assert await stored(session_factory, member.email) is not None


async def test_an_admin_cannot_revoke_an_owners_invitation(owner_client, client_as, admin):
    invited = (await invite(owner_client, role="owner")).json()

    async with client_as(admin) as client:
        response = await client.delete(f"/api/v1/users/{invited['id']}/invite")

    assert response.status_code == 403


async def test_removing_an_invited_person_kills_their_link(owner_client, session_factory):
    invited = (await invite(owner_client)).json()

    await owner_client.post(f"/api/v1/users/{invited['id']}/ban")

    assert (await stored(session_factory)).invite_token_hash is None
