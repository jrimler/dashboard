-- The upload pipeline replaces the time periods contained in each
-- REGULAR+SUPER batch (delete-then-insert) so uploads stay authoritative
-- for their quarters. The authenticated role needs DELETE for that step.
grant delete on public.enrollments to authenticated;
