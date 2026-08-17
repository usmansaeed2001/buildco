"""SQLAlchemy models.

Every model must be imported here. Alembic's autogenerate walks ``Base.metadata``, and
a model that is never imported is invisible to it — the classic way to silently lose a
table from a migration.
"""

from app.models.approval_request import ApprovalRequest
from app.models.attachment import Attachment
from app.models.base import Base
from app.models.estimate import Estimate
from app.models.meeting import Meeting, MeetingAttendee
from app.models.milestone import PaymentMilestone
from app.models.profile import Profile
from app.models.project import Project
from app.models.project_activity import ProjectActivity
from app.models.project_supplement import ProjectSupplement

__all__ = [
    "ApprovalRequest",
    "Attachment",
    "Base",
    "Estimate",
    "Meeting",
    "MeetingAttendee",
    "PaymentMilestone",
    "Profile",
    "Project",
    "ProjectActivity",
    "ProjectSupplement",
]
