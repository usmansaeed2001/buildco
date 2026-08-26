--
-- PostgreSQL database dump
--

\restrict LmwnB6zdkbZqXyfQtgLNa9TZYUeaOReyE0s91jNu5Y2PwyL9MUQPByZmCrY13BM

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);


--
-- Name: approval_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_requests (
    user_id uuid NOT NULL,
    email character varying(320) NOT NULL,
    full_name character varying(200) DEFAULT ''::character varying NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_approval_requests_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'denied'::character varying])::text[])))
);


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    estimate_id uuid NOT NULL,
    room_index integer DEFAULT 0 NOT NULL,
    item_index integer DEFAULT 0 NOT NULL,
    file_name character varying(500) NOT NULL,
    file_type character varying(200) NOT NULL,
    storage_path character varying(1000) NOT NULL,
    is_video boolean DEFAULT false NOT NULL,
    uploaded_by uuid,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: estimates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimates (
    created_by uuid,
    project_name character varying(300) DEFAULT 'New Estimate'::character varying NOT NULL,
    client_name character varying(300) DEFAULT ''::character varying NOT NULL,
    identifier character varying(40) NOT NULL,
    pm_name character varying(200) DEFAULT ''::character varying NOT NULL,
    insurance_carrier character varying(200) DEFAULT ''::character varying NOT NULL,
    rooms jsonb DEFAULT '[]'::jsonb NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    status character varying(30) DEFAULT 'active'::character varying NOT NULL,
    approval_token character varying(128),
    submitted_to character varying(320),
    submitted_at timestamp with time zone,
    submitted_by uuid,
    reviewed_at timestamp with time zone,
    review_note text,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_estimates_status_valid CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying, 'locked'::character varying, 'submitted'::character varying, 'approved'::character varying, 'rejected'::character varying, 'changes_requested'::character varying])::text[])))
);


--
-- Name: meeting_attendees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_attendees (
    meeting_id uuid NOT NULL,
    user_id uuid,
    email character varying(320) NOT NULL,
    name character varying(200) DEFAULT ''::character varying NOT NULL,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meetings (
    created_by uuid,
    project_id uuid,
    title character varying(300) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    location character varying(500) DEFAULT ''::character varying NOT NULL,
    start_time timestamp with time zone NOT NULL,
    end_time timestamp with time zone NOT NULL,
    color character varying(20) DEFAULT '#3B82F6'::character varying NOT NULL,
    meet_link character varying(1000),
    google_event_id character varying(200),
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_milestones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_milestones (
    project_id uuid NOT NULL,
    label character varying(300) NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    due_date date,
    notes text DEFAULT ''::text NOT NULL,
    paid boolean DEFAULT false NOT NULL,
    paid_at timestamp with time zone,
    paid_by uuid,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    firebase_uid character varying(128),
    email character varying(320) NOT NULL,
    full_name character varying(200) DEFAULT ''::character varying NOT NULL,
    phone character varying(40),
    avatar_url character varying(1000),
    role character varying(20) DEFAULT 'member'::character varying NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    removed_by uuid,
    removed_at timestamp with time zone,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_profiles_role_valid CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'member'::character varying])::text[]))),
    CONSTRAINT ck_profiles_status_valid CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'banned'::character varying])::text[])))
);


--
-- Name: project_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_activity (
    project_id uuid NOT NULL,
    user_id uuid,
    user_name character varying(200) DEFAULT ''::character varying NOT NULL,
    action character varying(200) NOT NULL,
    details text DEFAULT ''::text NOT NULL,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_supplements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_supplements (
    project_id uuid NOT NULL,
    estimate_id uuid NOT NULL,
    linked_by uuid,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    created_by uuid,
    assigned_to uuid,
    owner_name character varying(300) DEFAULT ''::character varying NOT NULL,
    address character varying(500) DEFAULT ''::character varying NOT NULL,
    work_type character varying(200) DEFAULT ''::character varying NOT NULL,
    start_date date,
    notes text DEFAULT ''::text NOT NULL,
    work_status character varying(30) DEFAULT 'contract_sent'::character varying NOT NULL,
    status character varying(30) DEFAULT 'active'::character varying NOT NULL,
    total_budget numeric(12,2) DEFAULT 0 NOT NULL,
    labor_cost numeric(12,2) DEFAULT 0 NOT NULL,
    materials_cost numeric(12,2) DEFAULT 0 NOT NULL,
    reimbursements numeric(12,2) DEFAULT 0 NOT NULL,
    amount_collected numeric(12,2) DEFAULT 0 NOT NULL,
    closing_form_1 jsonb,
    closing_form_2 jsonb,
    closing_form_submitted_at timestamp with time zone,
    closing_form_submitted_by uuid,
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_projects_status_valid CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'pending_payment'::character varying, 'closed'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT ck_projects_work_status_valid CHECK (((work_status)::text = ANY ((ARRAY['contract_sent'::character varying, 'contract_not_signed'::character varying, 'contract_signed'::character varying, 'start_date'::character varying, 'in_progress'::character varying, 'on_hold'::character varying, 'completed'::character varying])::text[])))
);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: approval_requests pk_approval_requests; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT pk_approval_requests PRIMARY KEY (id);


--
-- Name: attachments pk_attachments; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT pk_attachments PRIMARY KEY (id);


--
-- Name: estimates pk_estimates; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT pk_estimates PRIMARY KEY (id);


--
-- Name: meeting_attendees pk_meeting_attendees; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT pk_meeting_attendees PRIMARY KEY (id);


--
-- Name: meetings pk_meetings; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT pk_meetings PRIMARY KEY (id);


--
-- Name: payment_milestones pk_payment_milestones; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_milestones
    ADD CONSTRAINT pk_payment_milestones PRIMARY KEY (id);


--
-- Name: profiles pk_profiles; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT pk_profiles PRIMARY KEY (id);


--
-- Name: project_activity pk_project_activity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_activity
    ADD CONSTRAINT pk_project_activity PRIMARY KEY (id);


--
-- Name: project_supplements pk_project_supplements; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_supplements
    ADD CONSTRAINT pk_project_supplements PRIMARY KEY (id);


--
-- Name: projects pk_projects; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT pk_projects PRIMARY KEY (id);


--
-- Name: meeting_attendees uq_meeting_attendee; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT uq_meeting_attendee UNIQUE (meeting_id, user_id);


--
-- Name: project_supplements uq_project_supplement; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_supplements
    ADD CONSTRAINT uq_project_supplement UNIQUE (project_id, estimate_id);


--
-- Name: ix_approval_requests_requested_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_approval_requests_requested_at ON public.approval_requests USING btree (requested_at);


--
-- Name: ix_approval_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_approval_requests_status ON public.approval_requests USING btree (status);


--
-- Name: ix_approval_requests_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_approval_requests_user_id ON public.approval_requests USING btree (user_id);


--
-- Name: ix_attachments_estimate_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attachments_estimate_id ON public.attachments USING btree (estimate_id);


--
-- Name: ix_estimates_approval_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_estimates_approval_token ON public.estimates USING btree (approval_token);


--
-- Name: ix_estimates_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_estimates_created_by ON public.estimates USING btree (created_by);


--
-- Name: ix_estimates_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_estimates_deleted_at ON public.estimates USING btree (deleted_at);


--
-- Name: ix_estimates_identifier; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_estimates_identifier ON public.estimates USING btree (identifier);


--
-- Name: ix_estimates_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_estimates_status ON public.estimates USING btree (status);


--
-- Name: ix_meeting_attendees_meeting_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_meeting_attendees_meeting_id ON public.meeting_attendees USING btree (meeting_id);


--
-- Name: ix_meeting_attendees_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_meeting_attendees_user_id ON public.meeting_attendees USING btree (user_id);


--
-- Name: ix_meetings_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_meetings_project_id ON public.meetings USING btree (project_id);


--
-- Name: ix_meetings_start_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_meetings_start_time ON public.meetings USING btree (start_time);


--
-- Name: ix_payment_milestones_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payment_milestones_project_id ON public.payment_milestones USING btree (project_id);


--
-- Name: ix_profiles_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_profiles_email ON public.profiles USING btree (email);


--
-- Name: ix_profiles_firebase_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_profiles_firebase_uid ON public.profiles USING btree (firebase_uid);


--
-- Name: ix_project_activity_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_activity_project_id ON public.project_activity USING btree (project_id);


--
-- Name: ix_project_supplements_estimate_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_supplements_estimate_id ON public.project_supplements USING btree (estimate_id);


--
-- Name: ix_project_supplements_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_supplements_project_id ON public.project_supplements USING btree (project_id);


--
-- Name: ix_projects_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_projects_assigned_to ON public.projects USING btree (assigned_to);


--
-- Name: ix_projects_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_projects_status ON public.projects USING btree (status);


--
-- Name: ix_projects_work_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_projects_work_status ON public.projects USING btree (work_status);


--
-- Name: approval_requests fk_approval_requests_reviewed_by_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT fk_approval_requests_reviewed_by_profiles FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: approval_requests fk_approval_requests_user_id_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT fk_approval_requests_user_id_profiles FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: attachments fk_attachments_estimate_id_estimates; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT fk_attachments_estimate_id_estimates FOREIGN KEY (estimate_id) REFERENCES public.estimates(id) ON DELETE CASCADE;


--
-- Name: attachments fk_attachments_uploaded_by_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT fk_attachments_uploaded_by_profiles FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: estimates fk_estimates_created_by_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT fk_estimates_created_by_profiles FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: estimates fk_estimates_deleted_by_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT fk_estimates_deleted_by_profiles FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: estimates fk_estimates_submitted_by_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT fk_estimates_submitted_by_profiles FOREIGN KEY (submitted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: meeting_attendees fk_meeting_attendees_meeting_id_meetings; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT fk_meeting_attendees_meeting_id_meetings FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_attendees fk_meeting_attendees_user_id_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT fk_meeting_attendees_user_id_profiles FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: meetings fk_meetings_created_by_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT fk_meetings_created_by_profiles FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: meetings fk_meetings_project_id_projects; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT fk_meetings_project_id_projects FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: payment_milestones fk_payment_milestones_paid_by_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_milestones
    ADD CONSTRAINT fk_payment_milestones_paid_by_profiles FOREIGN KEY (paid_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: payment_milestones fk_payment_milestones_project_id_projects; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_milestones
    ADD CONSTRAINT fk_payment_milestones_project_id_projects FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: profiles fk_profiles_removed_by_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT fk_profiles_removed_by_profiles FOREIGN KEY (removed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: project_activity fk_project_activity_project_id_projects; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_activity
    ADD CONSTRAINT fk_project_activity_project_id_projects FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_activity fk_project_activity_user_id_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_activity
    ADD CONSTRAINT fk_project_activity_user_id_profiles FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: project_supplements fk_project_supplements_estimate_id_estimates; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_supplements
    ADD CONSTRAINT fk_project_supplements_estimate_id_estimates FOREIGN KEY (estimate_id) REFERENCES public.estimates(id) ON DELETE CASCADE;


--
-- Name: project_supplements fk_project_supplements_linked_by_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_supplements
    ADD CONSTRAINT fk_project_supplements_linked_by_profiles FOREIGN KEY (linked_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: project_supplements fk_project_supplements_project_id_projects; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_supplements
    ADD CONSTRAINT fk_project_supplements_project_id_projects FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: projects fk_projects_assigned_to_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT fk_projects_assigned_to_profiles FOREIGN KEY (assigned_to) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: projects fk_projects_closing_form_submitted_by_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT fk_projects_closing_form_submitted_by_profiles FOREIGN KEY (closing_form_submitted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: projects fk_projects_created_by_profiles; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT fk_projects_created_by_profiles FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict LmwnB6zdkbZqXyfQtgLNa9TZYUeaOReyE0s91jNu5Y2PwyL9MUQPByZmCrY13BM

