-- Tickets carry the same ecosystem assessment as plans. plan_id already exists
-- from the context-plane foundation; this only adds the remaining ticket field.

alter table board_items
  add column if not exists impact_map jsonb;
