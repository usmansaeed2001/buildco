"""Running an action's follow-up work from a route."""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import BackgroundTasks

from app.services.actions import FollowUp


def schedule(background: BackgroundTasks, follow_ups: Iterable[FollowUp]) -> None:
    """Queue follow-up work to run after the response, and so after the commit.

    ``BackgroundTasks`` runs once the response has been sent, by which point ``get_db``
    has committed. That ordering is what a ``FollowUp`` requires.
    """
    for follow_up in follow_ups:
        background.add_task(follow_up.func, *follow_up.args, **follow_up.kwargs)
