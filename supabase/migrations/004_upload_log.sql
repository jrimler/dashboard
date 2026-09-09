-- One row per completed upload run. Nothing else in the schema records when
-- data landed: every table is upserted in place, so an overwritten row leaves
-- no trace of the upload that wrote it. Staff running recurring reports need to
-- know how fresh the data is before quoting a number, hence this log.
--
-- Written after all upserts succeed, so a row here means the data is in.
create table if not exists upload_log (
  id                   bigint generated always as identity primary key,
  uploaded_at          timestamptz not null default now(),
  files                text[]  not null default '{}',  -- which of the four ASAP exports were included
  student_count        integer not null default 0,
  event_count          integer not null default 0,
  enrollment_count     integer not null default 0,
  class_schedule_count integer not null default 0,
  time_periods         text[]  not null default '{}'   -- quarters the enrollment batch replaced
);

-- The page reads the most recent rows first.
create index if not exists upload_log_uploaded_at on upload_log(uploaded_at desc);

grant select, insert on upload_log to authenticated;
