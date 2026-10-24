-- Figures for the Data Arts Report that ASAP doesn't hold: CMC's off-site
-- partner programs and event audiences. Program managers collect them; staff
-- enter them once per fiscal year on the Data Arts Input page.
--
-- One row per fiscal year; saving the form again overwrites that year's row.
-- A null column means "not entered" — the report withholds any total that
-- depends on it rather than reading it as 0.
create table if not exists data_arts_input (
  fiscal_year               text primary key check (fiscal_year ~ '^FY[0-9]{2}$'),
  partner_schools           integer check (partner_schools >= 0),
  partner_classes           integer check (partner_classes >= 0),
  partner_times_offered     integer check (partner_times_offered >= 0),
  partner_students          integer check (partner_students >= 0),
  partner_instruction_hours numeric check (partner_instruction_hours >= 0),
  paid_audience             integer check (paid_audience >= 0),
  free_audience             integer check (free_audience >= 0),
  updated_at                timestamptz not null default now(),
  updated_by                text          -- email of whoever last saved the row
);

-- Unlike the ASAP tables, this one is written from the browser, so it gets
-- explicit policies: any signed-in user may read and save; anon gets nothing.
alter table data_arts_input enable row level security;

create policy "data_arts_input read"   on data_arts_input for select to authenticated using (true);
create policy "data_arts_input insert" on data_arts_input for insert to authenticated with check (true);
create policy "data_arts_input update" on data_arts_input for update to authenticated using (true) with check (true);

grant select, insert, update on data_arts_input to authenticated;
-- Local check scripts (scripts/db.mjs) read with the service_role key.
grant select on data_arts_input to service_role;
