-- Rows that would FAIL the NOT NULL constraints in our schema.
-- Any row with nulls > 0 must be backfilled before the data load.
select 'approval_requests.full_name' as col, count(*) as nulls from public.approval_requests where full_name is null
union all
select 'approval_requests.requested_at' as col, count(*) as nulls from public.approval_requests where requested_at is null
union all
select 'attachments.is_video' as col, count(*) as nulls from public.attachments where is_video is null
union all
select 'attachments.created_at' as col, count(*) as nulls from public.attachments where created_at is null
union all
select 'estimates.client_name' as col, count(*) as nulls from public.estimates where client_name is null
union all
select 'estimates.pm_name' as col, count(*) as nulls from public.estimates where pm_name is null
union all
select 'estimates.insurance_carrier' as col, count(*) as nulls from public.estimates where insurance_carrier is null
union all
select 'estimates.notes' as col, count(*) as nulls from public.estimates where notes is null
union all
select 'estimates.created_at' as col, count(*) as nulls from public.estimates where created_at is null
union all
select 'estimates.updated_at' as col, count(*) as nulls from public.estimates where updated_at is null
union all
select 'meeting_attendees.name' as col, count(*) as nulls from public.meeting_attendees where name is null
union all
select 'meetings.created_at' as col, count(*) as nulls from public.meetings where created_at is null
union all
select 'meetings.description' as col, count(*) as nulls from public.meetings where description is null
union all
select 'meetings.location' as col, count(*) as nulls from public.meetings where location is null
union all
select 'meetings.color' as col, count(*) as nulls from public.meetings where color is null
union all
select 'payment_milestones.created_at' as col, count(*) as nulls from public.payment_milestones where created_at is null
union all
select 'payment_milestones.paid' as col, count(*) as nulls from public.payment_milestones where paid is null
union all
select 'payment_milestones.notes' as col, count(*) as nulls from public.payment_milestones where notes is null
union all
select 'profiles.full_name' as col, count(*) as nulls from public.profiles where full_name is null
union all
select 'profiles.created_at' as col, count(*) as nulls from public.profiles where created_at is null
union all
select 'project_activity.created_at' as col, count(*) as nulls from public.project_activity where created_at is null
union all
select 'project_activity.user_name' as col, count(*) as nulls from public.project_activity where user_name is null
union all
select 'project_activity.details' as col, count(*) as nulls from public.project_activity where details is null
union all
select 'project_supplements.linked_at' as col, count(*) as nulls from public.project_supplements where linked_at is null
union all
select 'projects.created_at' as col, count(*) as nulls from public.projects where created_at is null
union all
select 'projects.work_type' as col, count(*) as nulls from public.projects where work_type is null
union all
select 'projects.notes' as col, count(*) as nulls from public.projects where notes is null
union all
select 'projects.total_budget' as col, count(*) as nulls from public.projects where total_budget is null
union all
select 'projects.labor_cost' as col, count(*) as nulls from public.projects where labor_cost is null
union all
select 'projects.materials_cost' as col, count(*) as nulls from public.projects where materials_cost is null
union all
select 'projects.reimbursements' as col, count(*) as nulls from public.projects where reimbursements is null
order by nulls desc, col;
