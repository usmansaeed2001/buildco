"""SQLAlchemy models.

Every model must be imported here. Alembic's autogenerate walks ``Base.metadata``, and
a model that is never imported is invisible to it — the classic way to silently lose a
table from a migration.
"""

from app.models.agent import AgentAction, AgentConversation, AgentMemory, AgentMessage
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
from app.models.settings import SETTINGS_ROW_ID, CatalogueItem, TeamSettings

__all__ = [
    "SETTINGS_ROW_ID",
    "AgentAction",
    "AgentConversation",
    "AgentMemory",
    "AgentMessage",
    "ApprovalRequest",
    "Attachment",
    "Base",
    "CatalogueItem",
    "Estimate",
    "Meeting",
    "MeetingAttendee",
    "PaymentMilestone",
    "Profile",
    "Project",
    "ProjectActivity",
    "ProjectSupplement",
    "TeamSettings",
]
