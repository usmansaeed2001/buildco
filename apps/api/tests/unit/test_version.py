"""The version the API reports is the one the release build baked into the image.

The release workflow compares ``/livez`` against the number it is about to tag, so a
version that stopped following ``APP_VERSION`` would fail every release - or worse, pass
one by reporting a stale constant that happened to match.
"""

from __future__ import annotations

import importlib
from collections.abc import Iterator

import pytest

import app


@pytest.fixture
def reload_app(monkeypatch: pytest.MonkeyPatch) -> Iterator[pytest.MonkeyPatch]:
    """``__version__`` is read once, at import, so each case re-imports the package -
    and the fixture does it once more afterwards to leave the real value in place."""
    yield monkeypatch
    monkeypatch.undo()
    importlib.reload(app)


def test_the_release_build_sets_the_version(reload_app):
    reload_app.setenv("APP_VERSION", "9.9.9")

    assert importlib.reload(app).__version__ == "9.9.9"


@pytest.mark.parametrize("unset", [None, ""])
def test_anything_else_reports_the_placeholder(reload_app, unset):
    if unset is None:
        reload_app.delenv("APP_VERSION", raising=False)
    else:
        reload_app.setenv("APP_VERSION", unset)

    assert importlib.reload(app).__version__ == "0.0.0.dev0"
