"""Authentication handshake, profiles, the team roster, and access requests."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Header, Path, Query

from app.deps import CurrentUser, DbSession, Elevated
from app.models.enums import ApprovalRequestStatus
from app.schemas.common import Ack
from app.schemas.user import (
    AccountStatusOut,
    ApprovalRequestOut,
    AvatarSaveRequest,
    AvatarUploadOut,
    AvatarUploadRequest,
    RoleUpdate,
    SessionOut,
    UserOut,
    UserUpdate,
)
from app.services import notifications, user_service
from app.services.integrations import storage
from app.services.integrations.firebase import get_auth_provider

router = APIRouter()

# ── Authentication handshake ──────────────────────────────────────────────────

auth_router = APIRouter(prefix="/auth", tags=["auth"])


@auth_router.post("/session", response_model=SessionOut)
async def establish_session(
    db: DbSession,
    background: BackgroundTasks,
    authorization: Annotated[str | None, Header()] = None,
) -> SessionOut:
    """Exchange a Firebase ID token for the caller's application profile.

    The frontend calls this once after sign-in. It is what provisions a profile for a
    new user, links a migrated user to their Firebase uid on first sign-in, and gives
    the first person ever to sign in the owner role — all logic that used to live in
    the ``handle_new_user()`` Postgres trigger, which does not survive the move off
    Supabase Auth.

    This route resolves the identity itself rather than depending on
    ``get_current_user``, because it needs to know whether the profile was created or
    merely linked in order to report it.
    """
    from app.config import get_settings
    from app.deps import _extract_bearer

    settings = get_settings()
    token = "" if settings.auth_disabled else _extract_bearer(authorization)
    identity = await get_auth_provider().verify_id_token(token)

    resolved = await user_service.resolve_profile(db, identity)

    if resolved.created:
        background.add_task(
            notifications.notify_admins,
            f"👋 New member — {resolved.profile.display_name}",
            "notice.html",
            {
                "badge": "New Member",
                "tone": "green",
                "headline": "Someone new joined BuildCo",
                "body": "A new user signed in for the first time and has been added to the team.",
                "rows": [
                    ("Name", resolved.profile.full_name or "—"),
                    ("Email", resolved.profile.email),
                    ("Role", resolved.profile.role),
                ],
            },
            exclude_id=resolved.profile.id,
        )

    return SessionOut(
        user=UserOut.model_validate(resolved.profile),
        created=resolved.created,
        linked=resolved.linked,
    )


@auth_router.get("/status", response_model=AccountStatusOut)
async def account_status(
    db: DbSession,
    background: BackgroundTasks,
    email: Annotated[str, Query(max_length=320)],
) -> AccountStatusOut:
    """Check an account's standing before sign-in. **Public — no authentication.**

    The sign-in screen calls this so it can explain a rejection instead of failing
    opaquely. A removed user hitting it files one access request for an admin to
    review; repeated attempts do not file duplicates.
    """
    result = await user_service.check_account_status(db, email)

    if result.request_filed and result.profile is not None:
        background.add_task(
            notifications.notify_admins,
            f"⚠️ Access attempt — {result.profile.display_name}",
            "notice.html",
            {
                "badge": "Access Attempt",
                "tone": "amber",
                "headline": "A removed user tried to sign in",
                "body": (
                    f"{result.profile.display_name} attempted to access BuildCo. "
                    "Review the request in Team Settings to restore or deny access."
                ),
                "rows": [
                    ("Name", result.profile.full_name or "—"),
                    ("Email", result.profile.email),
                ],
            },
        )

    return AccountStatusOut(status=result.state, request_filed=result.request_filed)


# ── Profiles ──────────────────────────────────────────────────────────────────

users_router = APIRouter(prefix="/users", tags=["users"])


@users_router.get("/me", response_model=UserOut)
async def read_me(user: CurrentUser) -> UserOut:
    return UserOut.model_validate(user)


@users_router.patch("/me", response_model=UserOut)
async def update_me(body: UserUpdate, db: DbSession, user: CurrentUser) -> UserOut:
    """Update your own name and phone. Role and status are not settable here."""
    updated = await user_service.update_self(db, user, **body.model_dump(exclude_unset=True))
    return UserOut.model_validate(updated)


@users_router.post("/me/avatar-upload-url", response_model=AvatarUploadOut)
async def create_avatar_upload_url(body: AvatarUploadRequest, user: CurrentUser) -> AvatarUploadOut:
    """Mint a signed URL for uploading your avatar directly to Cloud Storage."""
    path = storage.avatar_path(str(user.id), body.file_name)
    signed = await storage.create_upload_url("avatars", path, body.content_type)
    return AvatarUploadOut(
        upload_url=signed.upload_url,
        storage_path=signed.storage_path,
        required_headers=signed.required_headers,
        expires_in=signed.expires_in,
        public_url=storage.public_url("avatars", path),
    )


@users_router.put("/me/avatar", response_model=UserOut)
async def save_avatar(body: AvatarSaveRequest, db: DbSession, user: CurrentUser) -> UserOut:
    """Record the avatar URL after the upload has completed."""
    updated = await user_service.set_avatar(db, user, body.avatar_url)
    return UserOut.model_validate(updated)


@users_router.get("", response_model=list[UserOut])
async def list_team(db: DbSession, user: CurrentUser) -> list[UserOut]:
    """The team roster.

    Available to every authenticated user, not only admins: assignee names and avatars
    appear throughout the UI and a member has to be able to resolve them.
    """
    people = await user_service.list_team(db)
    return [UserOut.model_validate(p) for p in people]


@users_router.patch("/{user_id}/role", response_model=UserOut)
async def assign_role(
    body: RoleUpdate,
    db: DbSession,
    actor: Elevated,
    user_id: Annotated[uuid.UUID, Path()],
) -> UserOut:
    """Change a team member's role.

    The finer constraints — no self-promotion, only owners grant ownership, only
    owners change another owner — live in ``user_rules.can_assign_role``.
    """
    updated = await user_service.assign_role(db, actor, user_id, body.role)
    return UserOut.model_validate(updated)


@users_router.post("/{user_id}/ban", response_model=UserOut)
async def ban_user(
    db: DbSession,
    background: BackgroundTasks,
    actor: Elevated,
    user_id: Annotated[uuid.UUID, Path()],
) -> UserOut:
    """Remove a member from the team, disabling them in Firebase as well."""
    target = await user_service.ban_user(db, actor, user_id)

    background.add_task(
        notifications.notify_admins,
        f"🚫 Member removed — {target.display_name}",
        "notice.html",
        {
            "badge": "Member Removed",
            "tone": "red",
            "headline": f"{target.display_name} was removed",
            "body": f"Removed by {actor.display_name}.",
            "rows": [("Email", target.email), ("Removed by", actor.display_name)],
        },
        exclude_id=actor.id,
    )
    return UserOut.model_validate(target)


# ── Access requests ───────────────────────────────────────────────────────────

approvals_router = APIRouter(prefix="/approval-requests", tags=["access requests"])


@approvals_router.get("", response_model=list[ApprovalRequestOut])
async def list_requests(
    db: DbSession,
    actor: Elevated,
    request_status: Annotated[
        ApprovalRequestStatus | None, Query(alias="status")
    ] = ApprovalRequestStatus.PENDING,
) -> list[ApprovalRequestOut]:
    """Requests from removed users asking to be let back in."""
    rows = await user_service.list_approval_requests(db, status=request_status)
    return [ApprovalRequestOut.model_validate(r) for r in rows]


@approvals_router.post("/{request_id}/approve", response_model=Ack)
async def approve_request(
    db: DbSession,
    background: BackgroundTasks,
    actor: Elevated,
    request_id: Annotated[uuid.UUID, Path()],
) -> Ack:
    """Restore a removed user's access."""
    _, target = await user_service.review_approval_request(db, actor, request_id, approve=True)
    background.add_task(
        notifications.notify_one,
        target.email,
        "✅ Your BuildCo access has been restored",
        "notice.html",
        {
            "badge": "Access Restored",
            "tone": "green",
            "headline": "Your access has been restored",
            "body": "You can now sign in to BuildCo as normal.",
        },
    )
    return Ack()


@approvals_router.post("/{request_id}/deny", response_model=Ack)
async def deny_request(
    db: DbSession,
    background: BackgroundTasks,
    actor: Elevated,
    request_id: Annotated[uuid.UUID, Path()],
) -> Ack:
    """Decline a removed user's request to return."""
    _, target = await user_service.review_approval_request(db, actor, request_id, approve=False)
    background.add_task(
        notifications.notify_one,
        target.email,
        "Your BuildCo access request was declined",
        "notice.html",
        {
            "badge": "Request Declined",
            "tone": "grey",
            "headline": "Your access request was declined",
            "body": "Please contact your team if you believe this is a mistake.",
        },
    )
    return Ack()


router.include_router(auth_router)
router.include_router(users_router)
router.include_router(approvals_router)

__all__ = ["router"]
