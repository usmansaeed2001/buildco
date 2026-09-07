--
-- PostgreSQL database dump
--

\restrict amtvq2ALKWSVWfFmNMyJUh1uFamZkwd0dsV7JwpjMvcnn1eensKvd0X8zJEANPl

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
declare user_count int;
begin
  select count(*) into user_count from public.profiles;
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''), case when user_count = 0 then 'owner' else 'member' end);
  return new;
end;
$$;


--
-- Name: handle_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin new.updated_at = now(); return new; end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: approval_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    email text NOT NULL,
    full_name text DEFAULT ''::text,
    requested_at timestamp with time zone DEFAULT now(),
    status text DEFAULT 'pending'::text NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    CONSTRAINT approval_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text])))
);


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    estimate_id uuid NOT NULL,
    room_index integer DEFAULT 0 NOT NULL,
    item_index integer DEFAULT 0 NOT NULL,
    file_name text NOT NULL,
    file_type text NOT NULL,
    storage_path text NOT NULL,
    is_video boolean DEFAULT false,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: estimates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by uuid,
    project_name text DEFAULT 'New Estimate'::text NOT NULL,
    client_name text DEFAULT ''::text,
    identifier text NOT NULL,
    pm_name text DEFAULT ''::text,
    insurance_carrier text DEFAULT ''::text,
    rooms jsonb DEFAULT '[]'::jsonb NOT NULL,
    notes text DEFAULT ''::text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    approval_token text,
    submitted_to text,
    submitted_at timestamp with time zone,
    submitted_by uuid,
    reviewed_at timestamp with time zone,
    review_note text,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT estimates_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text, 'locked'::text, 'submitted'::text, 'approved'::text, 'rejected'::text, 'changes_requested'::text])))
);


--
-- Name: meeting_attendees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_attendees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    user_id uuid NOT NULL,
    email text NOT NULL,
    name text DEFAULT ''::text
);


--
-- Name: meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meetings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    created_by uuid,
    title text NOT NULL,
    description text DEFAULT ''::text,
    location text DEFAULT ''::text,
    start_time timestamp with time zone NOT NULL,
    end_time timestamp with time zone NOT NULL,
    color text DEFAULT '#3B82F6'::text,
    project_id uuid,
    meet_link text,
    google_event_id text
);


--
-- Name: payment_milestones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_milestones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    label text NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    due_date date,
    paid boolean DEFAULT false,
    paid_at timestamp with time zone,
    paid_by uuid,
    notes text DEFAULT ''::text
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    email text NOT NULL,
    full_name text DEFAULT ''::text,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    status text DEFAULT 'active'::text NOT NULL,
    removed_by uuid,
    removed_at timestamp with time zone,
    avatar_url text,
    phone text,
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))),
    CONSTRAINT profiles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'banned'::text, 'pending_approval'::text])))
);


--
-- Name: project_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_activity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    user_name text DEFAULT ''::text,
    action text NOT NULL,
    details text DEFAULT ''::text
);


--
-- Name: project_supplements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_supplements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    estimate_id uuid NOT NULL,
    linked_at timestamp with time zone DEFAULT now(),
    linked_by uuid
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    created_by uuid,
    owner_name text DEFAULT ''::text NOT NULL,
    address text DEFAULT ''::text NOT NULL,
    work_type text DEFAULT ''::text,
    start_date date,
    notes text DEFAULT ''::text,
    assigned_to uuid,
    total_budget numeric(12,2) DEFAULT 0,
    labor_cost numeric(12,2) DEFAULT 0,
    materials_cost numeric(12,2) DEFAULT 0,
    reimbursements numeric(12,2) DEFAULT 0,
    amount_collected numeric(12,2) DEFAULT 0,
    work_status text DEFAULT 'contract_sent'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    closing_form_1 jsonb,
    closing_form_2 jsonb,
    closing_form_submitted_at timestamp with time zone,
    closing_form_submitted_by uuid,
    CONSTRAINT projects_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending_payment'::text, 'closed'::text, 'lost'::text]))),
    CONSTRAINT projects_work_status_check CHECK ((work_status = ANY (ARRAY['contract_sent'::text, 'contract_not_signed'::text, 'contract_signed'::text, 'start_date'::text, 'in_progress'::text, 'on_hold'::text, 'completed'::text])))
);


--
-- Name: approval_requests approval_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: estimates estimates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_pkey PRIMARY KEY (id);


--
-- Name: meeting_attendees meeting_attendees_meeting_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT meeting_attendees_meeting_id_user_id_key UNIQUE (meeting_id, user_id);


--
-- Name: meeting_attendees meeting_attendees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT meeting_attendees_pkey PRIMARY KEY (id);


--
-- Name: meetings meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_pkey PRIMARY KEY (id);


--
-- Name: payment_milestones payment_milestones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_milestones
    ADD CONSTRAINT payment_milestones_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: project_activity project_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_activity
    ADD CONSTRAINT project_activity_pkey PRIMARY KEY (id);


--
-- Name: project_supplements project_supplements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_supplements
    ADD CONSTRAINT project_supplements_pkey PRIMARY KEY (id);


--
-- Name: project_supplements project_supplements_project_id_estimate_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_supplements
    ADD CONSTRAINT project_supplements_project_id_estimate_id_key UNIQUE (project_id, estimate_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: estimates on_estimates_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_estimates_updated BEFORE UPDATE ON public.estimates FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();


--
-- Name: approval_requests approval_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: approval_requests approval_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: attachments attachments_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimates(id) ON DELETE CASCADE;


--
-- Name: attachments attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: estimates estimates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: estimates estimates_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: estimates estimates_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: meeting_attendees meeting_attendees_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT meeting_attendees_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_attendees meeting_attendees_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT meeting_attendees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: meetings meetings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: meetings meetings_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: payment_milestones payment_milestones_paid_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_milestones
    ADD CONSTRAINT payment_milestones_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: payment_milestones payment_milestones_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_milestones
    ADD CONSTRAINT payment_milestones_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_removed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_removed_by_fkey FOREIGN KEY (removed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: project_activity project_activity_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_activity
    ADD CONSTRAINT project_activity_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_activity project_activity_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_activity
    ADD CONSTRAINT project_activity_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: project_supplements project_supplements_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_supplements
    ADD CONSTRAINT project_supplements_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimates(id) ON DELETE CASCADE;


--
-- Name: project_supplements project_supplements_linked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_supplements
    ADD CONSTRAINT project_supplements_linked_by_fkey FOREIGN KEY (linked_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: project_supplements project_supplements_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_supplements
    ADD CONSTRAINT project_supplements_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: projects projects_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: projects projects_closing_form_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_closing_form_submitted_by_fkey FOREIGN KEY (closing_form_submitted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: projects projects_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: profiles Anyone can read profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read profiles" ON public.profiles FOR SELECT USING (true);


--
-- Name: attachments Auth users can delete attachments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can delete attachments" ON public.attachments FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: meeting_attendees Auth users can delete attendees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can delete attendees" ON public.meeting_attendees FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: meetings Auth users can delete meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can delete meetings" ON public.meetings FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: payment_milestones Auth users can delete milestones; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can delete milestones" ON public.payment_milestones FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_supplements Auth users can delete project supplements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can delete project supplements" ON public.project_supplements FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: projects Auth users can delete projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can delete projects" ON public.projects FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_activity Auth users can insert activity; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can insert activity" ON public.project_activity FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: approval_requests Auth users can insert approval requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can insert approval requests" ON public.approval_requests FOR INSERT WITH CHECK (true);


--
-- Name: attachments Auth users can insert attachments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can insert attachments" ON public.attachments FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: meeting_attendees Auth users can insert attendees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can insert attendees" ON public.meeting_attendees FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: meetings Auth users can insert meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can insert meetings" ON public.meetings FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: payment_milestones Auth users can insert milestones; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can insert milestones" ON public.payment_milestones FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: project_supplements Auth users can insert project supplements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can insert project supplements" ON public.project_supplements FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: projects Auth users can insert projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can insert projects" ON public.projects FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: project_activity Auth users can read activity; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can read activity" ON public.project_activity FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: approval_requests Auth users can read approval requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can read approval requests" ON public.approval_requests FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: attachments Auth users can read attachments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can read attachments" ON public.attachments FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: meeting_attendees Auth users can read attendees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can read attendees" ON public.meeting_attendees FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: meetings Auth users can read meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can read meetings" ON public.meetings FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: payment_milestones Auth users can read milestones; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can read milestones" ON public.payment_milestones FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_supplements Auth users can read project supplements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can read project supplements" ON public.project_supplements FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: projects Auth users can read projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can read projects" ON public.projects FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: approval_requests Auth users can update approval requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can update approval requests" ON public.approval_requests FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: meetings Auth users can update meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can update meetings" ON public.meetings FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: payment_milestones Auth users can update milestones; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can update milestones" ON public.payment_milestones FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: projects Auth users can update projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users can update projects" ON public.projects FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: estimates Auth users delete estimates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users delete estimates" ON public.estimates FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: estimates Auth users insert estimates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users insert estimates" ON public.estimates FOR INSERT WITH CHECK ((auth.uid() = created_by));


--
-- Name: estimates Auth users read estimates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users read estimates" ON public.estimates FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: estimates Auth users update estimates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Auth users update estimates" ON public.estimates FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: profiles Users can update own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING ((auth.uid() = id));


--
-- Name: approval_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: estimates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_attendees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meeting_attendees ENABLE ROW LEVEL SECURITY;

--
-- Name: meetings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_milestones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_milestones ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: project_activity; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_activity ENABLE ROW LEVEL SECURITY;

--
-- Name: project_supplements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_supplements ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict amtvq2ALKWSVWfFmNMyJUh1uFamZkwd0dsV7JwpjMvcnn1eensKvd0X8zJEANPl

