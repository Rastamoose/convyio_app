-- Plans and tickets remember the conversation they came from. Assumed owner
-- and resource stay on the Plan as proposed responsibility, not authority.

alter table board_plans
  add column if not exists origin_channel_id text references channels(id),
  add column if not exists origin_event_id text,
  add column if not exists assumed_owner_id text references actors(id),
  add column if not exists assumed_project_id text references projects(id),
  add column if not exists change_log jsonb not null default '[]'::jsonb;

create index if not exists idx_board_plans_origin_channel
  on board_plans (workspace_id, origin_channel_id)
  where origin_channel_id is not null;

alter table board_items
  add column if not exists origin_channel_id text references channels(id),
  add column if not exists origin_event_id text;

create index if not exists idx_board_items_origin_channel
  on board_items (workspace_id, origin_channel_id)
  where origin_channel_id is not null;
