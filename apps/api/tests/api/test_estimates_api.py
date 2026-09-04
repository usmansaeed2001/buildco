"""Estimate endpoints, end to end through HTTP."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime


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


# ── The project manager defaults to whoever created the estimate ──────────────


async def test_a_new_estimate_names_its_creator_as_project_manager(owner_client, owner):
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "X"})).json()

    assert estimate["pm_name"] == owner.full_name


async def test_an_explicit_project_manager_survives(owner_client):
    """The default fills a blank; it never overwrites a name someone typed."""
    estimate = (
        await owner_client.post(
            "/api/v1/estimates", json={"project_name": "X", "pm_name": "Dana Delegate"}
        )
    ).json()

    assert estimate["pm_name"] == "Dana Delegate"


async def test_the_project_manager_default_falls_back_to_email(client_as, session_factory):
    """``display_name`` is ``full_name || email``, so a profile with no name still gets one."""
    from app.models.enums import Role
    from app.models.profile import Profile
    from tests.conftest import _make_profile

    nameless = await _make_profile(session_factory, role=Role.OWNER)
    async with session_factory() as session:
        row = await session.get(Profile, nameless.id)
        assert row is not None
        row.full_name = ""
        await session.commit()

    async with client_as(nameless) as client:
        estimate = (await client.post("/api/v1/estimates", json={"project_name": "X"})).json()

    assert estimate["pm_name"] == nameless.email


# ── The date window and the ids listing ───────────────────────────────────────


async def _created_at(db, estimate_id: str, when: datetime) -> None:
    """Backdate an estimate. ``created_at`` has a server default, so it cannot be set."""
    from app.models.estimate import Estimate as EstimateModel

    row = await db.get(EstimateModel, uuid.UUID(estimate_id))
    assert row is not None
    row.created_at = when
    await db.commit()


async def test_estimates_can_be_filtered_by_a_date_window(owner_client, db):
    old = (await owner_client.post("/api/v1/estimates", json={"project_name": "Old"})).json()
    await owner_client.post("/api/v1/estimates", json={"project_name": "New"})
    await _created_at(db, old["id"], datetime(2026, 1, 1, tzinfo=UTC))

    listed = (
        await owner_client.get("/api/v1/estimates", params={"created_from": "2026-06-01T00:00:00Z"})
    ).json()

    assert [e["project_name"] for e in listed["items"]] == ["New"]


async def test_the_window_upper_bound_is_inclusive(owner_client, db):
    old = (await owner_client.post("/api/v1/estimates", json={"project_name": "Old"})).json()
    await _created_at(db, old["id"], datetime(2026, 1, 1, 12, 0, tzinfo=UTC))

    listed = (
        await owner_client.get("/api/v1/estimates", params={"created_to": "2026-01-01T12:00:00Z"})
    ).json()

    assert [e["project_name"] for e in listed["items"]] == ["Old"]


async def test_the_date_window_narrows_the_total_not_just_the_page(owner_client, db):
    """The count query and the row query must apply the same conditions.

    A pager built from a total that ignored the filter would offer pages that come back
    empty.
    """
    old = (await owner_client.post("/api/v1/estimates", json={"project_name": "Old"})).json()
    await owner_client.post("/api/v1/estimates", json={"project_name": "New"})
    await _created_at(db, old["id"], datetime(2026, 1, 1, tzinfo=UTC))

    listed = (
        await owner_client.get("/api/v1/estimates", params={"created_from": "2026-06-01T00:00:00Z"})
    ).json()

    assert listed["total"] == 1


async def test_the_ids_listing_returns_every_visible_estimate(owner_client):
    """It backs the unread dots, which have to see past the current page."""
    for name in ["A", "B", "C"]:
        await owner_client.post("/api/v1/estimates", json={"project_name": name})

    listed = (await owner_client.get("/api/v1/estimates/ids")).json()

    assert len(listed) == 3
    assert set(listed[0]) == {"id", "status"}


async def test_the_ids_listing_is_scoped_like_the_list_itself(owner_client, member_client):
    await owner_client.post("/api/v1/estimates", json={"project_name": "Owner's"})

    assert (await member_client.get("/api/v1/estimates/ids")).json() == []


async def test_the_ids_listing_excludes_the_trash(owner_client):
    """A dot for something in the bin would send you looking for a row that is not there."""
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "A"})).json()
    await owner_client.delete(f"/api/v1/estimates/{estimate['id']}")

    assert (await owner_client.get("/api/v1/estimates/ids")).json() == []


async def test_ids_is_not_parsed_as_an_estimate_id(owner_client):
    """Route order: `/estimates/ids` must win over `/estimates/{estimate_id}`."""
    assert (await owner_client.get("/api/v1/estimates/ids")).status_code == 200


# ── Sorting ───────────────────────────────────────────────────────────────────


async def _touch(db, estimate_id: str, *, created=None, updated=None) -> None:
    """Set timestamps directly. Both have defaults, so they cannot be posted."""
    from app.models.estimate import Estimate as EstimateModel

    row = await db.get(EstimateModel, uuid.UUID(estimate_id))
    assert row is not None
    if created is not None:
        row.created_at = created
    if updated is not None:
        row.updated_at = updated
    await db.commit()


async def test_the_default_order_is_unchanged_when_no_sort_is_given(owner_client, db):
    """Newest-created, as this endpoint has always answered.

    The staff list now asks for `recently_edited`, but it asks *explicitly*. Moving the
    server's answer to an unchanged request would silently reorder the list for every
    other caller.
    """
    first = (await owner_client.post("/api/v1/estimates", json={"project_name": "First"})).json()
    second = (await owner_client.post("/api/v1/estimates", json={"project_name": "Second"})).json()
    await _touch(db, first["id"], created=datetime(2026, 1, 1, tzinfo=UTC))
    await _touch(db, second["id"], created=datetime(2026, 6, 1, tzinfo=UTC))

    default = (await owner_client.get("/api/v1/estimates")).json()
    explicit = (
        await owner_client.get("/api/v1/estimates", params={"sort": "recently_created"})
    ).json()

    assert [e["project_name"] for e in default["items"]] == ["Second", "First"]
    assert [e["id"] for e in default["items"]] == [e["id"] for e in explicit["items"]]


async def test_sorting_by_recently_edited_uses_the_updated_time(owner_client, db):
    stale = (await owner_client.post("/api/v1/estimates", json={"project_name": "Stale"})).json()
    fresh = (await owner_client.post("/api/v1/estimates", json={"project_name": "Fresh"})).json()
    # Created in the other order, so this can only pass by reading `updated_at`.
    await _touch(
        db,
        stale["id"],
        created=datetime(2026, 6, 1, tzinfo=UTC),
        updated=datetime(2026, 1, 1, tzinfo=UTC),
    )
    await _touch(
        db,
        fresh["id"],
        created=datetime(2026, 1, 1, tzinfo=UTC),
        updated=datetime(2026, 6, 1, tzinfo=UTC),
    )

    listed = (
        await owner_client.get("/api/v1/estimates", params={"sort": "recently_edited"})
    ).json()

    assert [e["project_name"] for e in listed["items"]] == ["Fresh", "Stale"]


async def test_sorting_by_highest_total_uses_the_stored_column(owner_client):
    await create_estimate(
        owner_client,
        project_name="Small",
        rooms=[{"name": "A", "items": [{"name": "x", "quantity": "1", "unitCost": "10.00"}]}],
    )
    await create_estimate(
        owner_client,
        project_name="Large",
        rooms=[{"name": "A", "items": [{"name": "x", "quantity": "100", "unitCost": "10.00"}]}],
    )

    listed = (await owner_client.get("/api/v1/estimates", params={"sort": "highest_total"})).json()

    assert [e["project_name"] for e in listed["items"]] == ["Large", "Small"]


async def test_sorting_by_client_name_is_alphabetical(owner_client):
    for client_name in ["Zenith", "Acme", "Meridian"]:
        await owner_client.post(
            "/api/v1/estimates", json={"project_name": client_name, "client_name": client_name}
        )

    listed = (await owner_client.get("/api/v1/estimates", params={"sort": "client_name"})).json()

    assert [e["client_name"] for e in listed["items"]] == ["Acme", "Meridian", "Zenith"]


async def test_an_unrecognised_sort_value_is_rejected(owner_client):
    response = await owner_client.get("/api/v1/estimates", params={"sort": "cheapest"})

    assert response.status_code == 422


async def test_estimates_tied_on_the_sort_key_paginate_without_repeating_or_skipping_a_row(
    owner_client, db
):
    """The reason every ordering ends with `id`.

    Without a tiebreaker the database is free to return tied rows in any order it likes,
    and it need not pick the same order twice. Paging then shows one row on both pages
    and drops another entirely — which reads as data loss and is horrible to reproduce.
    """
    same_moment = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
    for index in range(6):
        created = (
            await owner_client.post("/api/v1/estimates", json={"project_name": f"Tied {index}"})
        ).json()
        await _touch(db, created["id"], created=same_moment, updated=same_moment)

    pages = []
    for offset in (0, 3):
        page = (
            await owner_client.get("/api/v1/estimates", params={"limit": 3, "offset": offset})
        ).json()
        pages.extend(e["id"] for e in page["items"])
    everything = (await owner_client.get("/api/v1/estimates", params={"limit": 6})).json()

    assert len(set(pages)) == 6
    assert pages == [e["id"] for e in everything["items"]]


# ── The stored total ──────────────────────────────────────────────────────────


async def _stored_total(db, estimate_id: str) -> str:
    from app.models.estimate import Estimate as EstimateModel

    row = await db.get(EstimateModel, uuid.UUID(estimate_id))
    assert row is not None
    await db.refresh(row)
    return str(row.total_amount)


async def test_the_stored_total_matches_the_computed_one_on_create(owner_client, db):
    estimate = await create_estimate(owner_client)

    assert await _stored_total(db, estimate["id"]) == estimate["totals"]["total"]


async def test_the_stored_total_follows_an_edit_to_the_rooms(owner_client, db):
    estimate = await create_estimate(owner_client)

    updated = (
        await owner_client.patch(
            f"/api/v1/estimates/{estimate['id']}",
            json={
                "rooms": [
                    {
                        "name": "Roof",
                        "items": [{"name": "Shingles", "quantity": "10", "unitCost": "9.00"}],
                    }
                ]
            },
        )
    ).json()

    assert updated["totals"]["total"] == "90.00"
    assert await _stored_total(db, estimate["id"]) == "90.00"


async def test_a_patch_that_does_not_touch_rooms_leaves_the_stored_total_alone(owner_client, db):
    estimate = await create_estimate(owner_client)
    before = await _stored_total(db, estimate["id"])

    await owner_client.patch(
        f"/api/v1/estimates/{estimate['id']}", json={"client_name": "Someone else"}
    )

    assert await _stored_total(db, estimate["id"]) == before


async def test_sorting_by_total_reflects_an_edit_made_after_creation(owner_client):
    """The end-to-end one. A forgotten `_sync_total` on the update path fails here."""
    small = await create_estimate(
        owner_client,
        project_name="Was small",
        rooms=[{"name": "A", "items": [{"name": "x", "quantity": "1", "unitCost": "1.00"}]}],
    )
    await create_estimate(
        owner_client,
        project_name="Was large",
        rooms=[{"name": "A", "items": [{"name": "x", "quantity": "50", "unitCost": "1.00"}]}],
    )

    await owner_client.patch(
        f"/api/v1/estimates/{small['id']}",
        json={
            "rooms": [
                {"name": "A", "items": [{"name": "x", "quantity": "999", "unitCost": "1.00"}]}
            ]
        },
    )

    listed = (await owner_client.get("/api/v1/estimates", params={"sort": "highest_total"})).json()
    assert [e["project_name"] for e in listed["items"]] == ["Was small", "Was large"]


# ── The claim ID ──────────────────────────────────────────────────────────────


async def test_a_blank_claim_id_falls_back_to_a_generated_one(owner_client):
    estimate = (
        await owner_client.post(
            "/api/v1/estimates", json={"project_name": "X", "identifier": "   "}
        )
    ).json()

    assert estimate["identifier"].startswith("CLM-")


async def test_a_supplied_claim_id_is_kept_verbatim(owner_client):
    estimate = (
        await owner_client.post(
            "/api/v1/estimates", json={"project_name": "X", "identifier": "  0833781057 "}
        )
    ).json()

    assert estimate["identifier"] == "0833781057"


async def test_a_claim_id_with_spaces_is_accepted(owner_client):
    """Deliberate. Real identifiers in this business include "Self Pay".

    A character whitelist is the obvious instinct and would reject the data already in
    the database.
    """
    estimate = (
        await owner_client.post(
            "/api/v1/estimates", json={"project_name": "X", "identifier": "Self Pay"}
        )
    ).json()

    assert estimate["identifier"] == "Self Pay"


async def test_a_duplicate_claim_id_is_refused_rather_than_silently_renumbered(owner_client):
    """The branch this whole change exists for.

    The retry loop mints a fresh identifier on a collision, which is right for a generated
    one and wrong for a typed one — the caller would get a 201 for a claim ID they never
    asked for and would not notice until the field had changed under them.
    """
    await owner_client.post(
        "/api/v1/estimates", json={"project_name": "First", "identifier": "DUP-1"}
    )

    response = await owner_client.post(
        "/api/v1/estimates", json={"project_name": "Second", "identifier": "DUP-1"}
    )

    assert response.status_code == 409
    assert "DUP-1" in response.json()["error"]["message"]
    # And nothing was created under a substituted identifier.
    listed = (await owner_client.get("/api/v1/estimates")).json()
    assert [e["project_name"] for e in listed["items"]] == ["First"]


async def test_a_claim_id_can_be_changed_after_the_fact(owner_client):
    estimate = await create_estimate(owner_client)

    updated = (
        await owner_client.patch(
            f"/api/v1/estimates/{estimate['id']}", json={"identifier": "KWSKWS26030022"}
        )
    ).json()

    assert updated["identifier"] == "KWSKWS26030022"


async def test_renaming_a_claim_id_to_one_already_in_use_is_a_409(owner_client):
    await owner_client.post(
        "/api/v1/estimates", json={"project_name": "First", "identifier": "TAKEN"}
    )
    second = await create_estimate(owner_client)

    response = await owner_client.patch(
        f"/api/v1/estimates/{second['id']}", json={"identifier": "TAKEN"}
    )

    assert response.status_code == 409


async def test_blanking_a_claim_id_is_refused_rather_than_regenerating(owner_client):
    """Quietly reassigning a claim ID during an edit is a surprise nobody asked for."""
    estimate = await create_estimate(owner_client)

    response = await owner_client.patch(
        f"/api/v1/estimates/{estimate['id']}", json={"identifier": "  "}
    )

    assert response.status_code == 422


async def test_an_estimate_created_without_a_name_is_unnamed_rather_than_all_alike(owner_client):
    """`project_name` used to default to the literal "New Estimate".

    So an estimate created without one was not unnamed — it was named the same thing as
    every other one, and a list of them was a wall of identical rows.
    """
    estimate = (await owner_client.post("/api/v1/estimates", json={})).json()

    assert estimate["project_name"] == ""
