-- Prod stores these as unbounded text; our schema caps them at varchar(N).
-- Any row with too_long > 0 will be REJECTED by the data load.
select 'approval_requests.email' as col, 320 as cap, max(length(email)) as longest, count(*) filter (where length(email) > 320) as too_long from public.approval_requests
union all
select 'approval_requests.full_name' as col, 200 as cap, max(length(full_name)) as longest, count(*) filter (where length(full_name) > 200) as too_long from public.approval_requests
union all
select 'approval_requests.status' as col, 20 as cap, max(length(status)) as longest, count(*) filter (where length(status) > 20) as too_long from public.approval_requests
union all
select 'attachments.file_name' as col, 500 as cap, max(length(file_name)) as longest, count(*) filter (where length(file_name) > 500) as too_long from public.attachments
union all
select 'attachments.file_type' as col, 200 as cap, max(length(file_type)) as longest, count(*) filter (where length(file_type) > 200) as too_long from public.attachments
union all
select 'attachments.storage_path' as col, 1000 as cap, max(length(storage_path)) as longest, count(*) filter (where length(storage_path) > 1000) as too_long from public.attachments
union all
select 'estimates.approval_token' as col, 128 as cap, max(length(approval_token)) as longest, count(*) filter (where length(approval_token) > 128) as too_long from public.estimates
union all
select 'estimates.client_name' as col, 300 as cap, max(length(client_name)) as longest, count(*) filter (where length(client_name) > 300) as too_long from public.estimates
union all
select 'estimates.identifier' as col, 40 as cap, max(length(identifier)) as longest, count(*) filter (where length(identifier) > 40) as too_long from public.estimates
union all
select 'estimates.insurance_carrier' as col, 200 as cap, max(length(insurance_carrier)) as longest, count(*) filter (where length(insurance_carrier) > 200) as too_long from public.estimates
union all
select 'estimates.pm_name' as col, 200 as cap, max(length(pm_name)) as longest, count(*) filter (where length(pm_name) > 200) as too_long from public.estimates
union all
select 'estimates.project_name' as col, 300 as cap, max(length(project_name)) as longest, count(*) filter (where length(project_name) > 300) as too_long from public.estimates
union all
select 'estimates.status' as col, 30 as cap, max(length(status)) as longest, count(*) filter (where length(status) > 30) as too_long from public.estimates
union all
select 'estimates.submitted_to' as col, 320 as cap, max(length(submitted_to)) as longest, count(*) filter (where length(submitted_to) > 320) as too_long from public.estimates
union all
select 'meeting_attendees.email' as col, 320 as cap, max(length(email)) as longest, count(*) filter (where length(email) > 320) as too_long from public.meeting_attendees
union all
select 'meeting_attendees.name' as col, 200 as cap, max(length(name)) as longest, count(*) filter (where length(name) > 200) as too_long from public.meeting_attendees
union all
select 'meetings.color' as col, 20 as cap, max(length(color)) as longest, count(*) filter (where length(color) > 20) as too_long from public.meetings
union all
select 'meetings.google_event_id' as col, 200 as cap, max(length(google_event_id)) as longest, count(*) filter (where length(google_event_id) > 200) as too_long from public.meetings
union all
select 'meetings.location' as col, 500 as cap, max(length(location)) as longest, count(*) filter (where length(location) > 500) as too_long from public.meetings
union all
select 'meetings.meet_link' as col, 1000 as cap, max(length(meet_link)) as longest, count(*) filter (where length(meet_link) > 1000) as too_long from public.meetings
union all
select 'meetings.title' as col, 300 as cap, max(length(title)) as longest, count(*) filter (where length(title) > 300) as too_long from public.meetings
union all
select 'payment_milestones.label' as col, 300 as cap, max(length(label)) as longest, count(*) filter (where length(label) > 300) as too_long from public.payment_milestones
union all
select 'profiles.avatar_url' as col, 1000 as cap, max(length(avatar_url)) as longest, count(*) filter (where length(avatar_url) > 1000) as too_long from public.profiles
union all
select 'profiles.email' as col, 320 as cap, max(length(email)) as longest, count(*) filter (where length(email) > 320) as too_long from public.profiles
union all
select 'profiles.full_name' as col, 200 as cap, max(length(full_name)) as longest, count(*) filter (where length(full_name) > 200) as too_long from public.profiles
union all
select 'profiles.phone' as col, 40 as cap, max(length(phone)) as longest, count(*) filter (where length(phone) > 40) as too_long from public.profiles
union all
select 'profiles.role' as col, 20 as cap, max(length(role)) as longest, count(*) filter (where length(role) > 20) as too_long from public.profiles
union all
select 'profiles.status' as col, 20 as cap, max(length(status)) as longest, count(*) filter (where length(status) > 20) as too_long from public.profiles
union all
select 'project_activity.action' as col, 200 as cap, max(length(action)) as longest, count(*) filter (where length(action) > 200) as too_long from public.project_activity
union all
select 'project_activity.user_name' as col, 200 as cap, max(length(user_name)) as longest, count(*) filter (where length(user_name) > 200) as too_long from public.project_activity
union all
select 'projects.address' as col, 500 as cap, max(length(address)) as longest, count(*) filter (where length(address) > 500) as too_long from public.projects
union all
select 'projects.owner_name' as col, 300 as cap, max(length(owner_name)) as longest, count(*) filter (where length(owner_name) > 300) as too_long from public.projects
union all
select 'projects.work_type' as col, 200 as cap, max(length(work_type)) as longest, count(*) filter (where length(work_type) > 200) as too_long from public.projects
order by too_long desc, col;
