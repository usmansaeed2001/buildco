"""Export the project rules decision table for the frontend port to be tested against.

``apps/staff-web/src/domain/projectRules.ts`` re-implements ``project_rules.evaluate``
so the UI can explain a status rather than only display it. A hand-written port can
look right and still disagree in a corner nobody thought to test, and the two
disagreeing means the screen tells someone their project is closed while the database
says otherwise.

So the frontend does not test its port against hand-written expectations. It tests it
against *this* — every combination of work status, project status, closing-form pair
and milestone shape, run through the real engine.

Regenerate whenever ``project_rules.evaluate`` changes::

    cd apps/api
    uv run python scripts/export_project_rules_matrix.py \\
        > ../staff-web/src/domain/projectRules.matrix.json

Then run the frontend suite. A failure there is the port drifting, not a flaky test.
"""

from __future__ import annotations

import itertools
import json

from app.models.enums import ProjectStatus, WorkStatus
from app.services.rules.project_rules import MilestoneSnapshot, ProjectSnapshot, evaluate

#: Three shapes are enough: the empty case is special (counts as fully paid), and
#: beyond one unpaid milestone the rule does not change.
MILESTONE_SETS: dict[str, tuple[MilestoneSnapshot, ...]] = {
    "none": (),
    "all_paid": (MilestoneSnapshot("a", True),),
    "one_unpaid": (MilestoneSnapshot("a", True), MilestoneSnapshot("b", False)),
}

CLOSING_FORMS = [(False, False), (True, False), (False, True), (True, True)]


def build() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []

    for work_status, status, forms, milestones in itertools.product(
        list(WorkStatus), list(ProjectStatus), CLOSING_FORMS, MILESTONE_SETS
    ):
        decision = evaluate(
            ProjectSnapshot(
                work_status=work_status,
                status=status,
                has_closing_form_1=forms[0],
                has_closing_form_2=forms[1],
                milestones=MILESTONE_SETS[milestones],
            )
        )
        rows.append(
            {
                "workStatus": work_status.value,
                "status": status.value,
                "hasClosingForm1": forms[0],
                "hasClosingForm2": forms[1],
                "milestones": milestones,
                # The *resolved* state, not the decision's deltas: a `None` on the
                # decision means "leave it alone", which the frontend expresses as the
                # value staying put.
                "expectedWorkStatus": (decision.work_status or work_status).value,
                "expectedStatus": (decision.status or status).value,
            }
        )

    return rows


if __name__ == "__main__":
    print(json.dumps(build(), indent=0))
