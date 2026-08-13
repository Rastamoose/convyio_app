-- Board items grant capabilities, not only paths: a shell command's writes are
-- not statically knowable, so path scope alone cannot bound it. NULL keeps the
-- legacy meaning (file writes only) so existing approved items never silently
-- gain shell or network reach.
alter table board_items
  add column if not exists capabilities jsonb;

-- Durable permission requests. A paused run survives a server restart, and
-- every surface that shows the prompt resolves this one row.
create table if not exists interaction_requests (
  id               text primary key,
  workspace_id     text not null references workspaces(id) on delete cascade,
  channel_id       text not null,
  agent_id         text not null,
  conversation_id  text,
  summary          text not null,
  capability       text not null,
  board_item_ref   text,
  status           text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired')),
  resolved_by      text,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);

create index if not exists interaction_requests_pending_idx
  on interaction_requests (workspace_id, status, created_at);

alter table interaction_requests enable row level security;
