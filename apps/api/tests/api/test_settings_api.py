"""Team settings and the shared rate catalogue.

The behaviour worth pinning here is mostly about what happens when nothing has been
configured yet, and about the notification toggles actually gating mail — in the legacy
app those switches lived in ``localStorage`` and gated nothing, because the emails were
sent server-side and the browser was never consulted.
"""

from __future__ import annotations

import pytest

from app.services import settings_service

# ── Team settings ─────────────────────────────────────────────────────────────


async def test_settings_open_on_defaults_rather_than_404(member_client):
    """A settings screen that 404s until someone saves once is a worse first run."""
    response = await member_client.get("/api/v1/settings")

    assert response.status_code == 200
    body = response.json()
    assert body["custom_units"] == []
    assert body["custom_categories"] == []


async def test_every_notification_is_enabled_before_anyone_chooses(owner_client):
    """Absent means enabled: a preference nobody has expressed is not one to suppress
    mail, and adding a new notification later must not start out silently off."""
    prefs = (await owner_client.get("/api/v1/settings")).json()["notification_prefs"]

    assert prefs == {"estimate_locked": True, "member_joined": True, "member_removed": True}


async def test_a_member_can_read_but_not_change_settings(member_client):
    """The estimate editor needs the catalogue and the custom units to render."""
    assert (await member_client.get("/api/v1/settings")).status_code == 200

    response = await member_client.patch("/api/v1/settings", json={"custom_units": ["Roll"]})

    assert response.status_code == 403


async def test_custom_units_are_saved(owner_client):
    response = await owner_client.patch(
        "/api/v1/settings", json={"custom_units": ["Roll", "Bundle"]}
    )

    assert response.status_code == 200
    assert response.json()["custom_units"] == ["Roll", "Bundle"]


async def test_units_are_trimmed_deduplicated_and_blanks_dropped(owner_client):
    """Three entries that all mean the same thing is a dropdown nobody can use, and
    whichever one is stored on a line then fails to match the others."""
    response = await owner_client.patch(
        "/api/v1/settings", json={"custom_units": [" Roll ", "roll", "", "   ", "Bundle"]}
    )

    assert response.json()["custom_units"] == ["Roll", "Bundle"]


async def test_a_notification_toggle_is_merged_not_replaced(owner_client):
    """The client sends the switch that moved; replacing the map would reset the rest."""
    await owner_client.patch(
        "/api/v1/settings", json={"notification_prefs": {"member_joined": False}}
    )
    body = (
        await owner_client.patch(
            "/api/v1/settings", json={"notification_prefs": {"member_removed": False}}
        )
    ).json()

    assert body["notification_prefs"] == {
        "estimate_locked": True,
        "member_joined": False,
        "member_removed": False,
    }


async def test_an_unknown_notification_key_is_rejected(owner_client):
    """The stored value is opaque JSONB, so a typo would be accepted and then invisible:
    the switch would appear to work and the email would keep arriving."""
    response = await owner_client.patch(
        "/api/v1/settings", json={"notification_prefs": {"estimate_lockd": False}}
    )

    assert response.status_code == 422


async def test_settings_survive_a_reread(owner_client):
    await owner_client.patch("/api/v1/settings", json={"custom_categories": ["Roofing"]})

    assert (await owner_client.get("/api/v1/settings")).json()["custom_categories"] == ["Roofing"]


# ── Notification gating ───────────────────────────────────────────────────────


async def test_the_removal_notification_is_gated_on_a_setting(
    owner_client, admin, member, notifications
):
    """The route has to *declare* which setting governs it, or nothing can gate it.

    The `notifications` fixture records `pref` without acting on it — re-implementing
    the gate there would only test the fake. The gate itself is exercised below against
    the real `notify_admins`.
    """
    await owner_client.post(f"/api/v1/users/{member.id}/ban")

    removal = next(s for s in notifications.sent if "removed" in s.subject.lower())
    assert removal.pref == "member_removed"


async def test_an_access_attempt_is_deliberately_not_gated(owner_client, member, notifications, db):
    """A removed user trying to sign in is a security signal, not a routine update, and
    must not be silenceable from a settings screen."""
    await owner_client.post(f"/api/v1/users/{member.id}/ban")
    notifications.sent.clear()

    await owner_client.get("/api/v1/auth/status", params={"email": member.email})

    attempt = next(s for s in notifications.sent if "access attempt" in s.subject.lower())
    assert attempt.pref is None


async def test_a_disabled_setting_stops_the_real_notification(
    db, owner, session_factory, monkeypatch
):
    """The real ``notify_admins``, not a fake.

    The legacy toggles gated nothing at all, and a test written against a fake gate
    would not have caught that — so this drives the production function.

    Deliberately takes no HTTP client: ``app_factory`` depends on the ``notifications``
    fixture, which replaces ``notify_admins`` with a recorder. Any test that asks for a
    client is therefore testing the fake. The settings row is written through the
    service instead.

    ``notify_admins`` also opens its own session, because background tasks run after the
    request's session has closed — so the factory is patched too, or it would read a
    different database and find no admins.
    """
    from app.services import notifications as module
    from app.services.integrations import email as email_integration

    await settings_service.update_settings(
        db, owner, {"notification_prefs": {"member_removed": False}}
    )
    await db.commit()

    sent: list[str] = []

    async def fake_send(recipients, subject, template, context, attachments=None):  # type: ignore[no-untyped-def]
        sent.append(subject)
        return True

    monkeypatch.setattr(email_integration, "send_template_email", fake_send)
    monkeypatch.setattr(module, "get_session_factory", lambda: session_factory)

    await module.notify_admins("Suppressed", "notice.html", {}, pref="member_removed")
    assert sent == []

    # An untouched setting still lets its message through.
    await module.notify_admins("Delivered", "notice.html", {}, pref="member_joined")
    assert sent == ["Delivered"]

    # As does one that declares no preference at all.
    await module.notify_admins("Ungated", "notice.html", {})
    assert sent == ["Delivered", "Ungated"]


async def test_gating_fails_open_when_nothing_has_been_configured(db):
    """A notification that silently stopped because of a missing row is discovered
    weeks later when someone asks why nobody was told."""
    assert await settings_service.notifications_enabled(db, "member_removed") is True


# ── Catalogue ─────────────────────────────────────────────────────────────────


async def test_the_catalogue_starts_empty(member_client):
    response = await member_client.get("/api/v1/catalogue-items")

    assert response.status_code == 200
    assert response.json() == []


async def test_a_rate_can_be_added_and_read_back(owner_client, member_client):
    created = await owner_client.post(
        "/api/v1/catalogue-items",
        json={"name": "Drywall", "category": "drywall", "unit": "SF", "unit_cost": "2.50"},
    )

    assert created.status_code == 201
    assert created.json()["unit_cost"] == "2.50"

    # A member has to be able to read it, or they cannot price a line.
    listed = (await member_client.get("/api/v1/catalogue-items")).json()
    assert [item["name"] for item in listed] == ["Drywall"]


async def test_a_member_cannot_add_a_rate(member_client):
    """One person changing a rate changes what everyone quotes."""
    response = await member_client.post(
        "/api/v1/catalogue-items", json={"name": "Drywall", "unit_cost": "2.50"}
    )

    assert response.status_code == 403


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "", "unit_cost": "1.00"},
        {"name": "Drywall", "unit_cost": "-1.00"},
        {"name": "Drywall", "unit_cost": "1.005"},
    ],
    ids=["blank name", "negative cost", "three decimal places"],
)
async def test_invalid_rates_are_rejected(owner_client, payload):
    assert (await owner_client.post("/api/v1/catalogue-items", json=payload)).status_code == 422


async def test_a_rate_can_be_edited(owner_client):
    item = (
        await owner_client.post(
            "/api/v1/catalogue-items", json={"name": "Drywall", "unit_cost": "2.50"}
        )
    ).json()

    updated = await owner_client.patch(
        f"/api/v1/catalogue-items/{item['id']}", json={"unit_cost": "3.00"}
    )

    assert updated.json()["unit_cost"] == "3.00"
    assert updated.json()["name"] == "Drywall"


async def test_a_rate_can_be_deleted(owner_client):
    item = (
        await owner_client.post(
            "/api/v1/catalogue-items", json={"name": "Drywall", "unit_cost": "2.50"}
        )
    ).json()

    assert (await owner_client.delete(f"/api/v1/catalogue-items/{item['id']}")).status_code == 200
    assert (await owner_client.get("/api/v1/catalogue-items")).json() == []


async def test_a_member_cannot_delete_a_rate(owner_client, member_client):
    item = (
        await owner_client.post(
            "/api/v1/catalogue-items", json={"name": "Drywall", "unit_cost": "2.50"}
        )
    ).json()

    assert (await member_client.delete(f"/api/v1/catalogue-items/{item['id']}")).status_code == 403


async def test_deleting_a_missing_rate_is_a_404(owner_client):
    response = await owner_client.delete(
        "/api/v1/catalogue-items/00000000-0000-4000-8000-000000000099"
    )

    assert response.status_code == 404


async def test_rates_are_ordered_by_category_then_name(owner_client):
    for name, category in [("Paint", "painting"), ("Trim", "trim"), ("Drywall", "drywall")]:
        await owner_client.post(
            "/api/v1/catalogue-items", json={"name": name, "category": category}
        )

    listed = (await owner_client.get("/api/v1/catalogue-items")).json()

    assert [item["name"] for item in listed] == ["Drywall", "Paint", "Trim"]


# ── The default reviewer ──────────────────────────────────────────────────────


async def test_an_admin_can_choose_the_reviewer(owner_client, member):
    response = await owner_client.patch(
        "/api/v1/settings", json={"default_reviewer_id": str(member.id)}
    )

    assert response.status_code == 200
    assert response.json()["default_reviewer"]["id"] == str(member.id)
    assert response.json()["default_reviewer"]["email"] == member.email


async def test_a_member_can_be_the_reviewer(owner_client, member):
    """Signing off on an estimate is a business role, not an administrative permission.

    The approval itself is authorised by the emailed token, so naming a member here
    grants them nothing they could not already do from that link.
    """
    await owner_client.patch("/api/v1/settings", json={"default_reviewer_id": str(member.id)})

    reviewer = (await owner_client.get("/api/v1/settings")).json()["default_reviewer"]

    assert reviewer["role"] == "member"


async def test_the_reviewer_is_returned_resolved_not_as_a_bare_id(owner_client, admin):
    """The settings screen and the submit modal both need a name without a second call."""
    await owner_client.patch("/api/v1/settings", json={"default_reviewer_id": str(admin.id)})

    reviewer = (await owner_client.get("/api/v1/settings")).json()["default_reviewer"]

    assert reviewer["full_name"] == "Adam Admin"


async def test_a_banned_user_cannot_be_the_reviewer(owner_client, member, db):
    """An estimate sent to a banned reviewer could never be approved."""
    from app.models.enums import UserStatus
    from app.models.profile import Profile

    banned = await db.get(Profile, member.id)
    assert banned is not None
    banned.status = UserStatus.BANNED.value
    await db.commit()

    response = await owner_client.patch(
        "/api/v1/settings", json={"default_reviewer_id": str(member.id)}
    )

    assert response.status_code == 422


async def test_an_unknown_reviewer_is_a_404(owner_client):
    response = await owner_client.patch(
        "/api/v1/settings",
        json={"default_reviewer_id": "00000000-0000-4000-8000-000000000099"},
    )

    assert response.status_code == 404


async def test_a_member_cannot_choose_the_reviewer(member_client, admin):
    assert (
        await member_client.patch("/api/v1/settings", json={"default_reviewer_id": str(admin.id)})
    ).status_code == 403


async def test_no_reviewer_is_configured_by_default(owner_client):
    assert (await owner_client.get("/api/v1/settings")).json()["default_reviewer"] is None
