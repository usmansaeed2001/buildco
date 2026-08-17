"""User, team, and access-request schemas."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import EmailStr, Field

from app.models.enums import ApprovalRequestStatus, Role, UserStatus
from app.schemas.common import ORMSchema, Schema


class UserOut(ORMSchema):
    id: uuid.UUID
    email: str
    full_name: str = ""
    phone: str | None = None
    avatar_url: str | None = None
    role: Role
    status: UserStatus
    created_at: datetime
    #: Present so an admin screen can tell a migrated user from one who has actually
    #: signed in since the move to Firebase.
    firebase_uid: str | None = None


class UserUpdate(Schema):
    """Fields a user may change about themselves. Notably not role or status."""

    full_name: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=40)


class RoleUpdate(Schema):
    role: Role


class AvatarUploadRequest(Schema):
    file_name: str = Field(min_length=1, max_length=500)
    content_type: str = Field(min_length=1, max_length=200)


class AvatarUploadOut(ORMSchema):
    upload_url: str
    storage_path: str
    required_headers: dict[str, str]
    expires_in: int
    #: Where the avatar will be readable once the upload completes. Save this back
    #: through ``PUT /users/me/avatar``.
    public_url: str | None = None


class AvatarSaveRequest(Schema):
    avatar_url: str = Field(min_length=1, max_length=1000)


class SessionOut(ORMSchema):
    """Result of exchanging a Firebase token for an application profile."""

    user: UserOut
    #: True when this call created the profile — the frontend uses it to show a
    #: welcome state rather than the normal dashboard.
    created: bool = False
    #: True when the profile existed but was linked to its Firebase uid just now.
    linked: bool = False


AccountState = Literal["active", "banned", "not_found"]


class AccountStatusOut(ORMSchema):
    """Pre-sign-in check, so the login screen can explain a rejection.

    Deliberately says nothing beyond the state — no name, no role — because it is
    reachable without authentication.
    """

    status: AccountState
    #: Set when a removed user's request to return has been filed for review.
    request_filed: bool = False


class ApprovalRequestOut(ORMSchema):
    id: uuid.UUID
    user_id: uuid.UUID
    email: str
    full_name: str = ""
    status: ApprovalRequestStatus
    requested_at: datetime
    reviewed_at: datetime | None = None
    reviewed_by: uuid.UUID | None = None


class AccountStatusQuery(Schema):
    email: EmailStr
