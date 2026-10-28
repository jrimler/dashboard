-- 004 created upload_log without Row Level Security, and Supabase's linter
-- flags it (rls_disabled_in_public, October 2026). Today the grants alone keep
-- anon out — the anon key gets "permission denied" — but that rests on nobody
-- ever granting anon on this table. RLS makes the policy explicit, matching
-- data_arts_input (005).
--
-- The app only reads the newest row (Upload page) and inserts one row per
-- upload, both as a signed-in user, so those are the only policies.
-- Enable and create policies in one transaction so the Upload page never sees
-- RLS on with no policies (which would silently return zero rows).
begin;

alter table upload_log enable row level security;

create policy "upload_log read"   on upload_log for select to authenticated using (true);
create policy "upload_log insert" on upload_log for insert to authenticated with check (true);

commit;
