/**
 * Builders for API payloads used in tests.
 *
 * Every builder returns a complete, valid object and takes overrides, so a test states
 * only the field it is actually about. Hand-writing these inline is how test files
 * drift from the real contract — these are typed against the generated schema, so a
 * backend rename breaks them at compile time rather than at assertion time.
 *
 * Reminder: money is a **string** over the wire (`Decimal` → `"1234.56"`).
 */
import type {
  ActivityOut,
  AttachmentOut,
  ApprovalRequestOut,
  EstimateOut,
  EstimatePage,
  EstimateTotalsOut,
  MeetingOut,
  MilestoneOut,
  ProjectOut,
  TeamSettingsOut,
  ProjectPage,
  ReviewDecisionOut,
  ReviewEstimateOut,
  UserOut,
} from "@/api/types";
import type { Role } from "@/domain/enums";

let counter = 0;
/** Deterministic ids: readable in a failure message, and stable within a run. */
export function testId(prefix = "0000"): string {
  counter += 1;
  return `${prefix}0000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

export function resetFactories(): void {
  counter = 0;
}

export function makeUser(overrides: Partial<UserOut> = {}): UserOut {
  return {
    id: testId("11111111"),
    email: "casey@buildco.test",
    full_name: "Casey Owner",
    phone: null,
    avatar_url: null,
    role: "owner" as Role,
    status: "active",
    created_at: "2026-01-05T10:00:00Z",
    firebase_uid: "firebase-uid",
    invited_at: null,
    invite_pending: false,
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<TeamSettingsOut> = {}): TeamSettingsOut {
  return {
    custom_units: [],
    custom_categories: [],
    notification_prefs: { estimate_locked: true, member_joined: true, member_removed: true },
    agent_daily_minutes: 10,
    // Configured by default, because that is the state a working team is in — a
    // reviewer has to be chosen before an estimate can be sent at all. Tests about the
    // unconfigured case override this to `null` explicitly.
    default_reviewer: {
      id: testId("55555555"),
      email: "rita@buildco.test",
      full_name: "Rita Reviewer",
      avatar_url: null,
      role: "member",
    },
    updated_at: "2026-02-01T09:00:00Z",
    updated_by: null,
    ...overrides,
  };
}

export function makeTotals(overrides: Partial<EstimateTotalsOut> = {}): EstimateTotalsOut {
  return {
    total: "0.00",
    room_count: 0,
    item_count: 0,
    rooms: [],
    ...overrides,
  };
}

export function makeEstimate(overrides: Partial<EstimateOut> = {}): EstimateOut {
  return {
    id: testId("22222222"),
    identifier: "CLM-100200",
    project_name: "Water damage — kitchen",
    client_name: "Jordan Homeowner",
    pm_name: "",
    insurance_carrier: "",
    notes: "",
    rooms: [],
    status: "active",
    created_by: null,
    creator: null,
    created_at: "2026-02-01T09:00:00Z",
    updated_at: "2026-02-01T09:00:00Z",
    totals: makeTotals(),
    ...overrides,
  };
}

export function makeEstimatePage(
  items: EstimateOut[],
  overrides: Partial<EstimatePage> = {},
): EstimatePage {
  return {
    items,
    total: items.length,
    limit: 50,
    offset: 0,
    ...overrides,
  } as EstimatePage;
}

/** What an external reviewer sees. Deliberately snake_case (`unit_cost`) — this is a
 *  separate server-side projection, not the camelCase document stored in `rooms`. */
export function makeReviewEstimate(
  overrides: Partial<ReviewEstimateOut> = {},
): ReviewEstimateOut {
  return {
    project_name: "Water damage — kitchen",
    identifier: "CLM-100200",
    client_name: "Jordan Homeowner",
    insurance_carrier: "Acme Mutual",
    pm_name: "Casey Owner",
    submitted_by: "Casey Owner",
    submitted_at: "2026-02-05T12:00:00Z",
    status: "submitted",
    rooms: [
      {
        name: "Kitchen",
        total: "25.00",
        items: [
          {
            name: "Drywall",
            category: "drywall",
            unit: "SF",
            quantity: "10",
            unit_cost: "2.50",
            total: "25.00",
            notes: "",
          },
        ],
      },
    ],
    total: "25.00",
    room_count: 1,
    item_count: 1,
    decision_pending: true,
    review_note: null,
    ...overrides,
  };
}

export function makeReviewDecision(
  overrides: Partial<ReviewDecisionOut> = {},
): ReviewDecisionOut {
  return {
    status: "approved",
    project_name: "Water damage — kitchen",
    identifier: "CLM-100200",
    reviewed_at: "2026-02-06T09:30:00Z",
    message: "Thank you. This estimate has been approved and the team has been notified.",
    ...overrides,
  };
}

export function makeProject(overrides: Partial<ProjectOut> = {}): ProjectOut {
  return {
    id: testId("33333333"),
    owner_name: "Jordan Homeowner",
    address: "12 Oak Street",
    work_type: "Water mitigation",
    start_date: null,
    notes: "",
    work_status: "contract_sent",
    status: "active",
    total_budget: "24000.00",
    labor_cost: "0.00",
    materials_cost: "0.00",
    reimbursements: "0.00",
    amount_collected: "0.00",
    created_at: "2026-02-01T09:00:00Z",
    updated_at: "2026-02-01T09:00:00Z",
    ...overrides,
  } as ProjectOut;
}

export function makeProjectPage(
  items: ProjectOut[],
  overrides: Partial<ProjectPage> = {},
): ProjectPage {
  return { items, total: items.length, limit: 50, offset: 0, ...overrides } as ProjectPage;
}

export function makeMilestone(overrides: Partial<MilestoneOut> = {}): MilestoneOut {
  return {
    id: testId("44444444"),
    label: "Deposit",
    amount: "5000.00",
    due_date: null,
    notes: "",
    paid: false,
    paid_at: null,
    paid_by: null,
    created_at: "2026-02-01T09:00:00Z",
    ...overrides,
  } as MilestoneOut;
}

export function makeActivity(overrides: Partial<ActivityOut> = {}): ActivityOut {
  return {
    id: testId("55555555"),
    action: "Project created",
    details: "",
    user_name: "Casey Owner",
    created_at: "2026-02-01T09:00:00Z",
    ...overrides,
  } as ActivityOut;
}

export function makeAttachment(overrides: Partial<AttachmentOut> = {}): AttachmentOut {
  return {
    id: testId("66666666"),
    estimate_id: testId("22222222"),
    room_index: 0,
    item_index: 0,
    file_name: "photo.jpg",
    file_type: "image/jpeg",
    storage_path: "estimate/0_0_1.jpg",
    is_video: false,
    uploaded_by: null,
    created_at: "2026-02-01T09:00:00Z",
    url: "https://storage.test/photo.jpg",
    ...overrides,
  };
}

export function makeMeeting(overrides: Partial<MeetingOut> = {}): MeetingOut {
  return {
    id: testId("77777777"),
    title: "Site walkthrough",
    description: "",
    location: "",
    start_time: "2026-03-10T17:00:00Z",
    end_time: "2026-03-10T18:00:00Z",
    color: "#3B82F6",
    meet_link: null,
    project_id: null,
    creator: null,
    attendees: [],
    created_at: "2026-02-01T09:00:00Z",
    updated_at: "2026-02-01T09:00:00Z",
    ...overrides,
  } as MeetingOut;
}

export function makeApprovalRequest(
  overrides: Partial<ApprovalRequestOut> = {},
): ApprovalRequestOut {
  return {
    id: testId("88888888"),
    email: "removed@buildco.test",
    full_name: "Removed Person",
    status: "pending",
    requested_at: "2026-02-01T09:00:00Z",
    reviewed_at: null,
    ...overrides,
  } as ApprovalRequestOut;
}
