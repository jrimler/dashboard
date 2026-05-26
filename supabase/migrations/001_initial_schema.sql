-- Students: one row per unique student
create table if not exists students (
  customer_id          text primary key,
  first_name           text,
  last_name            text,
  birthdate            date,
  account_created_date timestamptz,
  gender               text,
  ethnicity            text,
  household_income     text,
  pronouns             text
);

-- Events: one row per unique class/lesson section
create table if not exists events (
  event_id                 text primary key,
  course_name              text,
  department               text,
  activity_type            text,  -- 'LESSON' or 'CLASS'
  location                 text,  -- campus name
  facility                 text,  -- room name
  is_virtual               boolean,
  primary_instructor       text,
  class_start_date         date,
  class_end_date           date,
  lesson_duration_minutes  integer,
  all_meetings             integer,
  fiscal_year              text,
  time_period              text
);

-- Enrollments: one row per unique enrollment
create table if not exists enrollments (
  event_enrollment_id  text primary key,
  event_id             text references events(event_id),
  customer_id          text references students(customer_id),
  time_period          text,
  fiscal_year          text,
  amount               numeric,
  total_discount       numeric,
  discount_type        text,
  is_tuition_free      boolean,
  instructor_name      text
);

-- Indexes for common filter patterns
create index if not exists enrollments_event_id       on enrollments(event_id);
create index if not exists enrollments_customer_id    on enrollments(customer_id);
create index if not exists enrollments_time_period    on enrollments(time_period);
create index if not exists enrollments_fiscal_year    on enrollments(fiscal_year);
create index if not exists events_location            on events(location);
create index if not exists events_activity_type       on events(activity_type);
create index if not exists events_fiscal_year         on events(fiscal_year);
