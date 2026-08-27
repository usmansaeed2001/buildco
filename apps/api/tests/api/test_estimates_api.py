"""Estimate endpoints, end to end through HTTP."""

from __future__ import annotations


async def create_estimate(client, **overrides):
    payload = {
        "project_name": "Water damage supplement",
        "client_name": "Acme Insurance",
        "rooms": [
            {
                "name": "Kitchen",
                "items": [
                    {
                        "name": "Drywall patch",
                        "category": "drywall",
                        "unit": "SF",
                        "quantity": "12",
                        "unitCost": "4.50",
                    }
                ],
            }
        ],
        **overrides,
    }
    response = await client.post("/api/v1/estimates", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# ── Creation ──────────────────────────────────────────────────────────────────


async def test_creating_an_estimate_assigns_a_claim_identifier(owner_client):
    estimate = await create_estimate(owner_client)

    assert estimate["identifier"].startswith("CLM-")
    assert len(estimate["identifier"]) == 10
    assert estimate["status"] == "active"


async def test_totals_are_computed_on_every_read(owner_client):
    estimate = await create_estimate(owner_client)

    assert estimate["totals"]["total"] == "54.00"
    assert estimate["totals"]["room_count"] == 1
    assert estimate["totals"]["item_count"] == 1


async def test_the_approval_token_is_never_exposed_to_staff(owner_client):
    estimate = await create_estimate(owner_client)

    assert "approval_token" not in estimate


async def test_unknown_fields_are_rejected_rather_than_ignored(owner_client):
    response = await owner_client.post(
        "/api/v1/estimates", json={"project_name": "X", "status": "approved"}
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"


async def test_a_line_item_category_outside_the_enum_is_accepted(owner_client):
    """Deliberately changed: this used to be a 422.

    ``ItemCategory`` and ``ItemUnit`` are now what the UI *offers*, not what the column
    *permits*. Two things forced it. A team can define its own categories and units in
    Settings, and a value you can define but not use is not a setting. And documents
    written by the legacy app already contain ``electrical`` and ``plumbing``, so under
    the enum the only way to keep such an estimate saveable was to rewrite those rows to
    ``other`` on every save — silently destroying someone's classification.

    Nothing computes on either field: totals use ``quantity * unitCost`` and the
    category only picks a swatch colour. Length is still bounded.
    """
    response = await owner_client.post(
        "/api/v1/estimates",
        json={
            "project_name": "X",
            "rooms": [{"name": "R", "items": [{"name": "I", "category": "invented"}]}],
        },
    )

    assert response.status_code == 201
    assert response.json()["rooms"][0]["items"][0]["category"] == "invented"


# ── Visibility ────────────────────────────────────────────────────────────────


async def test_a_member_does_not_see_another_members_estimates(client_as, owner, member):
    async with client_as(owner) as owner_client:
        await create_estimate(owner_client, project_name="Owner's estimate")

    async with client_as(member) as member_client:
        await create_estimate(member_client, project_name="Member's estimate")
        listing = (await member_client.get("/api/v1/estimates")).json()

    names = [e["project_name"] for e in listing["items"]]
    assert names == ["Member's estimate"]
    assert listing["total"] == 1


async def test_an_owner_sees_every_estimate(client_as, owner, member):
    async with client_as(member) as member_client:
        await create_estimate(member_client, project_name="Member's estimate")

    async with client_as(owner) as owner_client:
        await create_estimate(owner_client, project_name="Owner's estimate")
        listing = (await owner_client.get("/api/v1/estimates")).json()

    assert listing["total"] == 2


async def test_fetching_another_members_estimate_returns_404_not_403(client_as, owner, member):
    """A member has no business learning that another member's work exists."""
    async with client_as(owner) as owner_client:
        estimate = await create_estimate(owner_client)

    async with client_as(member) as member_client:
        response = await member_client.get(f"/api/v1/estimates/{estimate['id']}")

    assert response.status_code == 404


# ── Editing and locking ───────────────────────────────────────────────────────


async def test_a_locked_estimate_rejects_edits_from_an_admin(client_as, owner, admin):
    async with client_as(owner) as owner_client:
        estimate = await create_estimate(owner_client)
        await owner_client.post(
            f"/api/v1/estimates/{estimate['id']}/transitions", json={"action": "lock"}
        )

    async with client_as(admin) as admin_client:
        response = await admin_client.patch(
            f"/api/v1/estimates/{estimate['id']}", json={"project_name": "Renamed"}
        )

    assert response.status_code == 403
    assert "locked" in response.json()["error"]["message"].lower()


async def test_the_owner_can_still_edit_a_locked_estimate(owner_client):
    estimate = await create_estimate(owner_client)
    await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/transitions", json={"action": "lock"}
    )

    response = await owner_client.patch(
        f"/api/v1/estimates/{estimate['id']}", json={"project_name": "Renamed"}
    )

    assert response.status_code == 200
    assert response.json()["project_name"] == "Renamed"


async def test_a_member_cannot_lock_an_estimate(member_client):
    estimate = await create_estimate(member_client)

    response = await member_client.post(
        f"/api/v1/estimates/{estimate['id']}/transitions", json={"action": "lock"}
    )

    assert response.status_code == 403


async def test_locking_notifies_the_admins(owner_client, notifications):
    estimate = await create_estimate(owner_client)
    await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/transitions", json={"action": "lock"}
    )

    assert any("locked" in s.lower() for s in notifications.subjects())


async def test_an_unknown_transition_is_rejected_at_validation(owner_client):
    estimate = await create_estimate(owner_client)

    response = await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/transitions", json={"action": "obliterate"}
    )

    assert response.status_code == 422


# ── Trash ─────────────────────────────────────────────────────────────────────


async def test_deleting_moves_an_estimate_to_the_trash(owner_client):
    estimate = await create_estimate(owner_client)

    await owner_client.delete(f"/api/v1/estimates/{estimate['id']}")

    active = (await owner_client.get("/api/v1/estimates")).json()
    trashed = (await owner_client.get("/api/v1/estimates?trash=true")).json()

    assert active["total"] == 0
    assert trashed["total"] == 1


async def test_restoring_returns_an_estimate_to_active(owner_client):
    estimate = await create_estimate(owner_client)
    await owner_client.delete(f"/api/v1/estimates/{estimate['id']}")

    response = await owner_client.post(f"/api/v1/estimates/{estimate['id']}/restore")

    assert response.status_code == 200
    assert response.json()["status"] == "active"
    assert response.json()["deleted_at"] is None


async def test_a_member_cannot_restore_from_the_trash(member_client):
    estimate = await create_estimate(member_client)
    await member_client.delete(f"/api/v1/estimates/{estimate['id']}")

    response = await member_client.post(f"/api/v1/estimates/{estimate['id']}/restore")

    assert response.status_code == 403


async def test_a_member_cannot_permanently_delete_even_their_own_estimate(member_client):
    estimate = await create_estimate(member_client)

    response = await member_client.delete(f"/api/v1/estimates/{estimate['id']}/permanent")

    assert response.status_code == 403


async def test_a_trashed_estimate_cannot_be_edited(owner_client):
    estimate = await create_estimate(owner_client)
    await owner_client.delete(f"/api/v1/estimates/{estimate['id']}")

    response = await owner_client.patch(
        f"/api/v1/estimates/{estimate['id']}", json={"project_name": "Renamed"}
    )

    assert response.status_code == 409


# ── Search and filtering ──────────────────────────────────────────────────────


async def test_search_matches_project_and_client_names(owner_client):
    await create_estimate(owner_client, project_name="Roof repair")
    await create_estimate(owner_client, project_name="Basement flood")

    results = (await owner_client.get("/api/v1/estimates?q=roof")).json()

    assert results["total"] == 1
    assert results["items"][0]["project_name"] == "Roof repair"


async def test_filtering_by_status(owner_client):
    first = await create_estimate(owner_client)
    await create_estimate(owner_client)
    await owner_client.post(
        f"/api/v1/estimates/{first['id']}/transitions", json={"action": "archive"}
    )

    results = (await owner_client.get("/api/v1/estimates?status=archived")).json()

    assert results["total"] == 1


# ── Custom units and categories ───────────────────────────────────────────────


async def test_a_custom_unit_can_be_used_on_a_line(owner_client):
    """A team can define its own units in Settings. A value you can define but not use
    is not a setting — under the old enum, choosing "Roll" was a 422 for the whole
    estimate."""
    estimate = (await owner_client.post("/api/v1/estimates", json={})).json()

    response = await owner_client.patch(
        f"/api/v1/estimates/{estimate['id']}",
        json={
            "rooms": [
                {"name": "Store", "items": [{"name": "Wallpaper", "unit": "Roll", "quantity": "2"}]}
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["rooms"][0]["items"][0]["unit"] == "Roll"


async def test_a_legacy_category_survives_a_save_unchanged(owner_client):
    """Documents written by the legacy app contain categories the enums never had.

    Under the enum the only way to keep such an estimate saveable was to rewrite those
    rows to ``other`` on every save, silently destroying the classification someone
    chose.
    """
    estimate = (await owner_client.post("/api/v1/estimates", json={})).json()

    response = await owner_client.patch(
        f"/api/v1/estimates/{estimate['id']}",
        json={
            "rooms": [{"name": "Kitchen", "items": [{"name": "Outlet", "category": "electrical"}]}]
        },
    )

    assert response.status_code == 200
    assert response.json()["rooms"][0]["items"][0]["category"] == "electrical"


async def test_an_absurdly_long_unit_is_still_rejected(owner_client):
    """Free text, but not unbounded."""
    estimate = (await owner_client.post("/api/v1/estimates", json={})).json()

    response = await owner_client.patch(
        f"/api/v1/estimates/{estimate['id']}",
        json={"rooms": [{"name": "R", "items": [{"name": "X", "unit": "x" * 60}]}]},
    )

    assert response.status_code == 422
