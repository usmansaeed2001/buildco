"""FastAPI dependencies — authentication and authorisation.

This module is the whole authorisation story for the API. The rule the codebase
follows is: **a route declares who may call it, and a handler never re-checks.**

    @router.post("/projects")
    async def create(body: ProjectCreate, user: Elevated) -> ProjectOut: ...

That is the single largest structural fix over the legacy backend, where every handler
re-derived its own answer inline and they disagreed with each other — the estimates
list returned every estimate to any authenticated caller while the projects list
filtered by role.

Row-level access (may *this* member see *that* project) cannot be expressed at the
route, so it lives in the rules modules and is applied by services.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import Depends, Header, Path
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.errors import Forbidden, Unauthorized
from app.models.enums import ELEVATED_ROLES, Role
from app.models.profile import Profile
from app.models.project import Project
from app.services import project_service, user_service
from app.services.integrations.firebase import get_auth_provider

DbSession = Annotated[AsyncSession, Depends(get_db)]


def _extract_bearer(authorization: str | None) -> str:
    if not authorization:
        raise Unauthorized("Missing Authorization header.")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise Unauthorized("Expected an 'Authorization: Bearer <token>' header.")
    return token.strip()


async def get_current_user(
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> Profile:
    """Resolve the caller's profile from their Firebase ID token.

    Rejects a banned user here, at the edge, rather than in each handler. Because the
    check runs per request against the database, revoking access takes effect
    immediately — it does not wait for the user's existing token to expire.
    """
    settings = get_settings()
    provider = get_auth_provider()

    # In AUTH_DISABLED mode the header is optional; settings validation guarantees
    # this branch is unreachable in staging and production.
    token = "" if settings.auth_disabled else _extract_bearer(authorization)

    identity = await provider.verify_id_token(token)
    resolved = await user_service.resolve_profile(db, identity)
    profile = resolved.profile

    if profile.is_banned:
        raise Unauthorized("This account has been removed. Contact your team's owner.")

    return profile


CurrentUser = Annotated[Profile, Depends(get_current_user)]


def require_role(*roles: Role) -> Callable[[Profile], Awaitable[Profile]]:
    """Build a dependency that admits only the listed roles.

    Prefer the ``Elevated`` and ``Owner`` aliases below for the two common cases;
    reach for this directly only for an unusual combination.
    """
    allowed = frozenset(roles)

    async def guard(user: CurrentUser) -> Profile:
        if Role(user.role) not in allowed:
            names = "/".join(sorted(r.value for r in allowed))
            raise Forbidden(f"This action requires the {names} role.")
        return user

    return guard


#: Owners and admins. By far the most common guard.
Elevated = Annotated[Profile, Depends(require_role(*ELEVATED_ROLES))]

#: Owner only — locking estimates, and granting the owner role.
Owner = Annotated[Profile, Depends(require_role(Role.OWNER))]


async def require_project_access(
    project_id: Annotated[uuid.UUID, Path()],
    db: DbSession,
    user: CurrentUser,
) -> Project:
    """Load a project and confirm the caller may see it.

    Members reach only the projects assigned to them; owners and admins reach all of
    them. Returning the loaded object means the handler does not fetch it a second
    time, and it cannot forget to run the check.

    The rule itself lives in ``project_service.get_project``, so a caller that is not
    an HTTP route is held to it as well.
    """
    return await project_service.get_project(db, user, project_id)


AccessibleProject = Annotated[Project, Depends(require_project_access)]
