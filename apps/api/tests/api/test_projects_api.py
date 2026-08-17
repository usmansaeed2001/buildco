"""Project endpoints, with emphasis on the auto-transition chain end to end.

``test_project_rules.py`` proves the rules are right in isolation. These prove the
service actually applies them, on every route that can change the answer.
"""

from __future__ import annotations


async def make_project(client, **overrides):
    payload = {
        "owner_name": "Jordan Homeowner",
        "address": "12 Oak Street",
        "work_type": "Water mitigation",
        "total_budget": "24000.00",
        **overrides,
    }
    response = await client.post("/api/v1/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def add_milestone(client, project_id, label="Deposit", amount="5000.00"):
    response = await client.post(
        f"/api/v1/projects/{project_id}/milestones",
        json={"label": label, "amount": amount},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def set_paid(client, project_id, milestone_id, paid=True):
    return await client.patch(
        f"/api/v1/projects/{project_id}/milestones/{milestone_id}", json={"paid": paid}
    )


async def get_project(client, project_id):
    response = await client.get(f"/api/v1/projects/{project_id}")
    assert response.status_code == 200, response.text
    return response.json()["project"]


# ── Creation and access ───────────────────────────────────────────────────────


async def test_a_member_cannot_create_a_project(member_client):
    response = await member_client.post("/api/v1/projects", json={"owner_name": "Nope"})

    assert response.status_code == 403


async def test_a_new_project_starts_at_contract_sent_and_active(owner_client):
    project = await make_project(owner_client)

    assert project["work_status"] == "contract_sent"
    assert project["status"] == "active"


async def test_a_member_sees_only_projects_assigned_to_them(client_as, owner, member, other_member):
    async with client_as(owner) as owner_client:
        await make_project(owner_client, owner_name="Theirs", assigned_to=str(other_member.id))
        await make_project(owner_client, owner_name="Mine", assigned_to=str(member.id))

    async with client_as(member) as member_client:
        listing = (await member_client.get("/api/v1/projects")).json()

    assert [p["owner_name"] for p in listing["items"]] == ["Mine"]


async def test_an_unassigned_member_gets_404_for_a_project(client_as, owner, member):
    async with client_as(owner) as owner_client:
        project = await make_project(owner_client)

    async with client_as(member) as member_client:
        response = await member_client.get(f"/api/v1/projects/{project['id']}")

    assert response.status_code == 404


async def test_assigning_a_project_notifies_the_assignee(client_as, owner, member, notifications):
    async with client_as(owner) as owner_client:
        await make_project(owner_client, assigned_to=str(member.id))

    assert any(s.recipient == member.email for s in notifications.sent)


# ── The auto-transition chain ─────────────────────────────────────────────────


async def test_completing_work_with_an_unpaid_milestone_moves_to_pending_payment(
    owner_client,
):
    project = await make_project(owner_client)
    await add_milestone(owner_client, project["id"])

    await owner_client.patch(
        f"/api/v1/projects/{project['id']}/work-status",
        json={"work_status": "completed"},
    )

    assert (await get_project(owner_client, project["id"]))["status"] == "pending_payment"


async def test_paying_the_last_milestone_closes_a_completed_project(owner_client):
    project = await make_project(owner_client)
    milestone = await add_milestone(owner_client, project["id"])
    await owner_client.patch(
        f"/api/v1/projects/{project['id']}/work-status",
        json={"work_status": "completed"},
    )

    await set_paid(owner_client, project["id"], milestone["id"])

    assert (await get_project(owner_client, project["id"]))["status"] == "closed"


async def test_closing_a_project_notifies_the_admins(owner_client, notifications):
    project = await make_project(owner_client)
    milestone = await add_milestone(owner_client, project["id"])
    await owner_client.patch(
        f"/api/v1/projects/{project['id']}/work-status",
        json={"work_status": "completed"},
    )
    await set_paid(owner_client, project["id"], milestone["id"])

    assert "project_closed.html" in notifications.templates()


async def test_unpaying_a_milestone_reopens_a_closed_project(owner_client):
    """The legacy backend could not do this — a mistaken 'paid' click was permanent."""
    project = await make_project(owner_client)
    milestone = await add_milestone(owner_client, project["id"])
    await owner_client.patch(
        f"/api/v1/projects/{project['id']}/work-status",
        json={"work_status": "completed"},
    )
    await set_paid(owner_client, project["id"], milestone["id"])
    assert (await get_project(owner_client, project["id"]))["status"] == "closed"

    await set_paid(owner_client, project["id"], milestone["id"], paid=False)

    assert (await get_project(owner_client, project["id"]))["status"] == "pending_payment"


async def test_reverting_work_status_returns_the_project_to_active(owner_client):
    project = await make_project(owner_client)
    await owner_client.patch(
        f"/api/v1/projects/{project['id']}/work-status",
        json={"work_status": "completed"},
    )
    assert (await get_project(owner_client, project["id"]))["status"] == "closed"

    await owner_client.patch(
        f"/api/v1/projects/{project['id']}/work-status",
        json={"work_status": "in_progress"},
    )

    assert (await get_project(owner_client, project["id"]))["status"] == "active"


async def test_deleting_the_last_unpaid_milestone_closes_the_project(owner_client):
    project = await make_project(owner_client)
    milestone = await add_milestone(owner_client, project["id"])
    await owner_client.patch(
        f"/api/v1/projects/{project['id']}/work-status",
        json={"work_status": "completed"},
    )

    await owner_client.delete(f"/api/v1/projects/{project['id']}/milestones/{milestone['id']}")

    assert (await get_project(owner_client, project["id"]))["status"] == "closed"


async def test_adding_an_unpaid_milestone_reopens_a_closed_project(owner_client):
    project = await make_project(owner_client)
    await owner_client.patch(
        f"/api/v1/projects/{project['id']}/work-status",
        json={"work_status": "completed"},
    )
    assert (await get_project(owner_client, project["id"]))["status"] == "closed"

    await add_milestone(owner_client, project["id"], label="Final payment")

    assert (await get_project(owner_client, project["id"]))["status"] == "pending_payment"


# ── Closing forms ─────────────────────────────────────────────────────────────


async def test_one_closing_form_does_not_complete_the_work(owner_client):
    project = await make_project(owner_client)

    await owner_client.put(
        f"/api/v1/projects/{project['id']}/closing-forms/1",
        json={"data": {"signed_by": "Jordan"}},
    )

    fetched = await get_project(owner_client, project["id"])
    assert fetched["work_status"] == "contract_sent"
    assert fetched["closing_form_1"] == {"signed_by": "Jordan"}


async def test_both_closing_forms_complete_the_work_and_close_the_project(owner_client):
    project = await make_project(owner_client)

    await owner_client.put(
        f"/api/v1/projects/{project['id']}/closing-forms/1", json={"data": {"a": 1}}
    )
    await owner_client.put(
        f"/api/v1/projects/{project['id']}/closing-forms/2", json={"data": {"b": 2}}
    )

    fetched = await get_project(owner_client, project["id"])
    assert fetched["work_status"] == "completed"
    assert fetched["status"] == "closed"


async def test_both_forms_with_an_unpaid_milestone_stops_at_pending_payment(owner_client):
    project = await make_project(owner_client)
    await add_milestone(owner_client, project["id"])

    await owner_client.put(
        f"/api/v1/projects/{project['id']}/closing-forms/1", json={"data": {"a": 1}}
    )
    await owner_client.put(
        f"/api/v1/projects/{project['id']}/closing-forms/2", json={"data": {"b": 2}}
    )

    fetched = await get_project(owner_client, project["id"])
    assert fetched["work_status"] == "completed"
    assert fetched["status"] == "pending_payment"


async def test_an_unknown_closing_form_number_is_rejected(owner_client):
    project = await make_project(owner_client)

    response = await owner_client.put(
        f"/api/v1/projects/{project['id']}/closing-forms/3", json={"data": {}}
    )

    assert response.status_code == 422


# ── Derived status cannot be asserted directly ────────────────────────────────


async def test_closed_cannot_be_set_by_hand(owner_client):
    """It is a conclusion drawn from the milestones, not an assertion a client makes."""
    project = await make_project(owner_client)

    response = await owner_client.patch(
        f"/api/v1/projects/{project['id']}/status", json={"status": "closed"}
    )

    assert response.status_code == 422


async def test_cancelling_is_allowed_and_survives_the_rules_engine(owner_client):
    project = await make_project(owner_client)

    await owner_client.patch(
        f"/api/v1/projects/{project['id']}/status", json={"status": "cancelled"}
    )
    # Something that would otherwise close the project.
    await owner_client.patch(
        f"/api/v1/projects/{project['id']}/work-status",
        json={"work_status": "completed"},
    )

    assert (await get_project(owner_client, project["id"]))["status"] == "cancelled"


# ── Composition and audit trail ───────────────────────────────────────────────


async def test_relations_are_embedded_only_when_requested(owner_client):
    project = await make_project(owner_client)
    await add_milestone(owner_client, project["id"])

    bare = (await owner_client.get(f"/api/v1/projects/{project['id']}")).json()
    composed = (
        await owner_client.get(f"/api/v1/projects/{project['id']}?include=milestones,activity")
    ).json()

    assert bare["milestones"] is None
    assert len(composed["milestones"]) == 1
    assert len(composed["activity"]) >= 1


async def test_every_state_change_is_recorded_in_the_audit_trail(owner_client):
    project = await make_project(owner_client)
    milestone = await add_milestone(owner_client, project["id"])
    await owner_client.patch(
        f"/api/v1/projects/{project['id']}/work-status",
        json={"work_status": "completed"},
    )
    await set_paid(owner_client, project["id"], milestone["id"])

    activity = (await owner_client.get(f"/api/v1/projects/{project['id']}/activity")).json()
    actions = {entry["action"] for entry in activity}

    assert "Project created" in actions
    assert "Payment milestone added" in actions
    assert "Work status updated" in actions
    assert "Payment received" in actions
    assert "Project closed" in actions


async def test_activity_records_who_acted(owner_client, owner):
    project = await make_project(owner_client)

    activity = (await owner_client.get(f"/api/v1/projects/{project['id']}/activity")).json()

    assert activity[0]["user_name"] == owner.full_name


# ── Supplement links ──────────────────────────────────────────────────────────


async def test_linking_the_same_estimate_twice_is_rejected(owner_client):
    project = await make_project(owner_client)
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "Supp"})).json()

    first = await owner_client.post(
        f"/api/v1/projects/{project['id']}/supplements",
        json={"estimate_id": estimate["id"]},
    )
    second = await owner_client.post(
        f"/api/v1/projects/{project['id']}/supplements",
        json={"estimate_id": estimate["id"]},
    )

    assert first.status_code == 201
    assert second.status_code == 409


async def test_a_linked_supplement_carries_its_computed_total(owner_client):
    project = await make_project(owner_client)
    estimate = (
        await owner_client.post(
            "/api/v1/estimates",
            json={
                "project_name": "Supp",
                "rooms": [
                    {
                        "name": "Attic",
                        "items": [{"name": "Insulation", "quantity": "10", "unitCost": "3.00"}],
                    }
                ],
            },
        )
    ).json()

    link = (
        await owner_client.post(
            f"/api/v1/projects/{project['id']}/supplements",
            json={"estimate_id": estimate["id"]},
        )
    ).json()

    assert link["estimate"]["total"] == "30.00"
