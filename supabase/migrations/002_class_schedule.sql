CREATE TABLE IF NOT EXISTS class_schedule (
  event_id text PRIMARY KEY REFERENCES events(event_id),
  facility text,
  days_of_week text,
  start_time text,
  end_time text,
  age_min integer,
  age_max integer,
  course_id text
);

CREATE INDEX IF NOT EXISTS idx_class_schedule_event_id ON class_schedule(event_id);
