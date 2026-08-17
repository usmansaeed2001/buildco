"""The public estimate-review flow.

These endpoints are reachable with no signed-in user, so the tests run through an
anonymous client throughout — nothing here may depend on an authenticated session.
"""

from __future__ import annotations

import uuid

from app.models.estimate import Estimate
from app.services import estimate_service


async def submitted_estimate(owner_client, db) -> Estimate:
    """Create an estimate, send it for review, and return it with its token."""
    estimate = (
        await owner_client.post(
            "/api/v1/estimates",
            json={
                "project_name": "Storm damage supplement",
                "client_name": "Acme Insurance",
                "rooms": [
                    {
                        "name": "Roof",
                        "items": [{"name": "Shingles", "quantity": "20", "unitCost": "12.50"}],
                    }
                ],
            },
        )
    ).json()

    result = await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/submit",
        json={"recipient_email": "adjuster@acme-insurance.example.com", "recipient_name": "Alex"},
    )
    assert result.status_code == 200, result.text

    # Read the row back for its approval token, which the API deliberately never
    # returns to staff. The id must be a real UUID: the Uuid column type does not
    # coerce the string form.
    row = await db.get(Estimate, uuid.UUID(estimate["id"]))
    assert row is not None
    await db.refresh(row)
    return row


# ── Submission ────────────────────────────────────────────────────────────────


async def test_submitting_marks_the_estimate_and_returns_a_review_url(owner_client):
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "X"})).json()

    response = await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/submit",
        json={"recipient_email": "adjuster@acme-insurance.example.com"},
    )
    body = response.json()

    assert body["estimate"]["status"] == "submitted"
    assert body["estimate"]["submitted_to"] == "adjuster@acme-insurance.example.com"
    assert "/review/" in body["review_url"]


async def test_submitting_emails_the_reviewer(owner_client, notifications):
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "X"})).json()

    await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/submit",
        json={"recipient_email": "adjuster@acme-insurance.example.com"},
    )

    reviewer_mail = [
        s for s in notifications.sent if s.recipient == "adjuster@acme-insurance.example.com"
    ]
    assert len(reviewer_mail) == 1
    assert reviewer_mail[0].template == "estimate_review_request.html"


async def test_an_estimate_awaiting_a_decision_cannot_be_resubmitted(owner_client):
    """Minting a second token would silently orphan the first reviewer's link."""
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "X"})).json()
    await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/submit",
        json={"recipient_email": "a@acme-insurance.example.com"},
    )

    second = await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/submit",
        json={"recipient_email": "b@acme-insurance.example.com"},
    )

    assert second.status_code == 409


async def test_the_approval_token_is_long_and_random():
    tokens = {estimate_service.generate_approval_token() for _ in range(100)}

    assert len(tokens) == 100
    assert all(len(t) >= 40 for t in tokens)


# ── Reading a review ──────────────────────────────────────────────────────────


async def test_a_reviewer_can_read_the_estimate_without_signing_in(owner_client, anon_client, db):
    estimate = await submitted_estimate(owner_client, db)

    response = await anon_client.get(f"/api/v1/public/reviews/{estimate.approval_token}")
    body = response.json()

    assert response.status_code == 200
    assert body["project_name"] == "Storm damage supplement"
    assert body["total"] == "250.00"
    assert body["decision_pending"] is True
    assert body["rooms"][0]["items"][0]["total"] == "250.00"


async def test_the_reviewer_payload_exposes_no_internal_identifiers(owner_client, anon_client, db):
    estimate = await submitted_estimate(owner_client, db)

    body = (await anon_client.get(f"/api/v1/public/reviews/{estimate.approval_token}")).json()

    for leaked in ("id", "created_by", "approval_token", "creator", "deleted_at"):
        assert leaked not in body

    # The submitter appears as a display name so the reviewer knows who to reply to,
    # never as an internal id.
    assert body["submitted_by"] == "Olivia Owner"


async def test_an_unknown_token_is_a_404(anon_client):
    response = await anon_client.get("/api/v1/public/reviews/not-a-real-token")

    assert response.status_code == 404


# ── Decisions ─────────────────────────────────────────────────────────────────


async def test_approving_records_the_decision_and_spends_the_link(owner_client, anon_client, db):
    estimate = await submitted_estimate(owner_client, db)
    token = estimate.approval_token

    response = await anon_client.post(f"/api/v1/public/reviews/{token}/approve")

    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    # The token is burned, so the link cannot be replayed.
    assert (await anon_client.get(f"/api/v1/public/reviews/{token}")).status_code == 404


async def test_rejecting_records_the_decision(owner_client, anon_client, db):
    estimate = await submitted_estimate(owner_client, db)

    response = await anon_client.post(f"/api/v1/public/reviews/{estimate.approval_token}/reject")

    assert response.json()["status"] == "rejected"


async def test_a_decision_notifies_the_admins_and_the_submitter(
    owner_client, anon_client, db, notifications, owner
):
    estimate = await submitted_estimate(owner_client, db)
    notifications.sent.clear()

    await anon_client.post(f"/api/v1/public/reviews/{estimate.approval_token}/approve")

    kinds = {s.kind for s in notifications.sent}
    assert "admins" in kinds
    assert any(s.recipient == owner.email for s in notifications.sent)


async def test_approving_is_not_reachable_by_a_get(owner_client, anon_client, db):
    """As a GET link this mutated state on any prefetch — an email client or scanner
    that followed the URL approved the estimate on the reviewer's behalf."""
    estimate = await submitted_estimate(owner_client, db)

    response = await anon_client.get(f"/api/v1/public/reviews/{estimate.approval_token}/approve")

    assert response.status_code == 405


# ── Requesting changes ────────────────────────────────────────────────────────


async def test_requesting_changes_records_the_notes_and_keeps_the_link_alive(
    owner_client, anon_client, db
):
    estimate = await submitted_estimate(owner_client, db)
    token = estimate.approval_token

    response = await anon_client.post(
        f"/api/v1/public/reviews/{token}/request-changes",
        json={"notes": "Please itemise the roof underlayment separately."},
    )

    assert response.json()["status"] == "changes_requested"
    # Still readable: the submitter revises and the reviewer returns to the same URL.
    follow_up = await anon_client.get(f"/api/v1/public/reviews/{token}")
    assert follow_up.status_code == 200
    assert "underlayment" in follow_up.json()["review_note"]


async def test_requesting_changes_emails_the_submitter_with_the_notes(
    owner_client, anon_client, db, notifications, owner
):
    estimate = await submitted_estimate(owner_client, db)
    notifications.sent.clear()

    await anon_client.post(
        f"/api/v1/public/reviews/{estimate.approval_token}/request-changes",
        json={"notes": "Add the carpet removal line item."},
    )

    to_submitter = [s for s in notifications.sent if s.recipient == owner.email]
    assert len(to_submitter) == 1
    assert "carpet removal" in to_submitter[0].context["callout_body"]


async def test_empty_change_notes_are_rejected(owner_client, anon_client, db):
    estimate = await submitted_estimate(owner_client, db)

    response = await anon_client.post(
        f"/api/v1/public/reviews/{estimate.approval_token}/request-changes",
        json={"notes": ""},
    )

    assert response.status_code == 422


async def test_an_already_decided_estimate_reports_gone(owner_client, anon_client, db):
    estimate = await submitted_estimate(owner_client, db)
    token = estimate.approval_token
    await anon_client.post(
        f"/api/v1/public/reviews/{token}/request-changes", json={"notes": "Fix it"}
    )
    await db.commit()

    # After changes were requested the link still resolves, but a second decision on
    # an approved estimate must not.
    await anon_client.post(f"/api/v1/public/reviews/{token}/approve")
    second = await anon_client.post(f"/api/v1/public/reviews/{token}/approve")

    assert second.status_code == 404


# ── Recall invalidates the link ───────────────────────────────────────────────


async def test_recalling_an_estimate_invalidates_the_reviewers_link(owner_client, anon_client, db):
    estimate = await submitted_estimate(owner_client, db)
    token = estimate.approval_token

    await owner_client.post(
        f"/api/v1/estimates/{estimate.id}/transitions", json={"action": "recall"}
    )

    assert (await anon_client.get(f"/api/v1/public/reviews/{token}")).status_code == 404
