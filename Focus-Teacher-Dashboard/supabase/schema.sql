-- ClassMeet schema. Paste this whole file into Supabase > SQL Editor > Run.

create extension if not exists pgcrypto;

-- ───────────── Tables ─────────────
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null check (role in ('teacher','student')),
  created_at timestamptz not null default now()
);

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null unique references public.profiles(id) on delete cascade,
  class_code text not null unique,
  name text not null default 'My Class',
  created_at timestamptz not null default now()
);

create table public.enrollments (
  class_id uuid references public.classes(id) on delete cascade,
  student_id uuid references public.profiles(id) on delete cascade,
  enrolled_at timestamptz not null default now(),
  primary key (class_id, student_id)
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  meeting_code text,
  meeting_url text,
  status text not null default 'active' check (status in ('active','ended')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  report_sent_at timestamptz
);
create index on public.sessions (meeting_code);
create index on public.sessions (class_id, started_at desc);

create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  left_at timestamptz,
  in_meeting boolean not null default true,
  tab_active boolean not null default true,
  total_seconds int not null default 0,   -- time inside the Meet call
  active_seconds int not null default 0,  -- time inside the call with the tab in focus
  away_count int not null default 0,      -- times the student left the Meet tab
  unique (session_id, student_id)
);

create table public.attendance_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  event text not null,  -- joined | left | tab_away | tab_return
  created_at timestamptz not null default now()
);
create index on public.attendance_events (session_id, student_id, created_at);

-- ───────────── Class code + new-user trigger ─────────────
create or replace function public.generate_class_code() returns text
language plpgsql as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text; i int;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.classes where class_code = code);
  end loop;
  return code;
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role text := coalesce(new.raw_user_meta_data->>'role', 'student');
begin
  if v_role not in ('teacher','student') then v_role := 'student'; end if;
  insert into public.profiles (id, email, role) values (new.id, new.email, v_role);
  if v_role = 'teacher' then
    insert into public.classes (teacher_id, class_code) values (new.id, public.generate_class_code());
  end if;
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users for each row execute function public.handle_new_user();

-- ───────────── Helper functions (avoid RLS recursion) ─────────────
create or replace function public.is_teacher_of_class(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from classes where id = c and teacher_id = auth.uid()) $$;

create or replace function public.is_enrolled(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from enrollments where class_id = c and student_id = auth.uid()) $$;

create or replace function public.teaches_student(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from enrollments e join classes c on c.id = e.class_id
                 where e.student_id = s and c.teacher_id = auth.uid()) $$;

create or replace function public.is_teacher_of_session(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from sessions x join classes c on c.id = x.class_id
                 where x.id = s and c.teacher_id = auth.uid()) $$;

-- ───────────── Row Level Security ─────────────
alter table public.profiles          enable row level security;
alter table public.classes           enable row level security;
alter table public.enrollments       enable row level security;
alter table public.sessions          enable row level security;
alter table public.attendance        enable row level security;
alter table public.attendance_events enable row level security;

create policy "own profile"            on public.profiles for select using (id = auth.uid());
create policy "teacher sees students"  on public.profiles for select using (public.teaches_student(id));

create policy "teacher reads class"    on public.classes for select using (teacher_id = auth.uid());
create policy "teacher updates class"  on public.classes for update using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
create policy "student reads class"    on public.classes for select using (public.is_enrolled(id));

create policy "read enrollments"       on public.enrollments for select
  using (student_id = auth.uid() or public.is_teacher_of_class(class_id));
create policy "remove enrollment"      on public.enrollments for delete
  using (student_id = auth.uid() or public.is_teacher_of_class(class_id));

create policy "teacher manages sessions" on public.sessions for all
  using (public.is_teacher_of_class(class_id)) with check (public.is_teacher_of_class(class_id));
create policy "student reads sessions"   on public.sessions for select using (public.is_enrolled(class_id));

create policy "read attendance" on public.attendance for select
  using (student_id = auth.uid() or public.is_teacher_of_session(session_id));
create policy "read events" on public.attendance_events for select
  using (student_id = auth.uid() or public.is_teacher_of_session(session_id));
-- No insert/update policies on purpose: students can only write through record_presence().

-- ───────────── RPC: student joins a class by code ─────────────
create or replace function public.join_class(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_class uuid; v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is distinct from 'student' then raise exception 'Only students can join a class.'; end if;
  select id into v_class from classes where class_code = upper(trim(p_code));
  if v_class is null then raise exception 'That class code does not exist.'; end if;
  insert into enrollments (class_id, student_id) values (v_class, auth.uid()) on conflict do nothing;
  return v_class;
end $$;

-- ───────────── RPC: presence heartbeat (time is counted on the server) ─────────────
create or replace function public.record_presence(p_session uuid, p_tab_active boolean, p_event text default 'heartbeat')
returns text language plpgsql security definer set search_path = public as $$
declare
  v_class uuid; v_status text; r public.attendance%rowtype; v_delta int;
begin
  select class_id, status into v_class, v_status from sessions where id = p_session;
  if v_class is null or v_status <> 'active' then return 'session_inactive'; end if;
  if not exists (select 1 from enrollments where class_id = v_class and student_id = auth.uid()) then
    raise exception 'Not enrolled in this class.';
  end if;

  select * into r from attendance where session_id = p_session and student_id = auth.uid();

  if not found then
    insert into attendance (session_id, student_id, in_meeting, tab_active)
    values (p_session, auth.uid(), p_event <> 'left', p_tab_active);
    insert into attendance_events (session_id, student_id, event) values (p_session, auth.uid(), 'joined');
    return 'ok';
  end if;

  -- Seconds since the last ping, capped at 30 so a sleeping laptop is not counted as presence.
  v_delta := case when r.in_meeting
    then least(greatest(extract(epoch from (now() - r.last_seen))::int, 0), 30) else 0 end;

  update attendance set
    total_seconds  = total_seconds + v_delta,
    active_seconds = active_seconds + case when r.tab_active then v_delta else 0 end,
    tab_active     = p_tab_active,
    away_count     = away_count + case when p_event = 'tab_away' then 1 else 0 end,
    in_meeting     = case when p_event = 'left' then false when p_event = 'joined' then true else r.in_meeting end,
    left_at        = case when p_event = 'left' then now() when p_event = 'joined' then null else r.left_at end,
    last_seen      = now()
  where id = r.id;

  if p_event in ('joined','left','tab_away','tab_return') then
    insert into attendance_events (session_id, student_id, event) values (p_session, auth.uid(), p_event);
  end if;
  return 'ok';
end $$;

-- ───────────── Realtime for the dashboard ─────────────
alter publication supabase_realtime add table public.attendance, public.sessions;
