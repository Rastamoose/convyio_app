-- Durable current-state projection of Toolman executions. The append-only
-- chronology remains in thread_events; this table is the queryable snapshot.

create table tool_executions (
  id                 text primary key,
  workspace_id       text not null references workspaces(id) on delete cascade,
  channel_id         text,
  conversation_id    text,
  run_id             text,
  agent_id           text not null references actors(id),
  project_id         text not null references projects(id),
  mount_id           text not null references project_mounts(id),
  node_id            text not null references toolman_nodes(id),
  board_item_ref     text,
  action             text not null,
  status             text not null
    check (status in (
      'requested', 'awaiting_approval', 'running', 'completed',
      'failed', 'denied', 'cancelled'
    )),
  summary            text not null,
  input_preview      text not null,
  output_preview     text,
  input_object_key   text,
  input_sha256       text,
  input_bytes        bigint,
  output_object_key  text,
  output_sha256      text,
  output_bytes       bigint,
  exit_code          integer,
  error              text,
  started_at         bigint not null,
  completed_at       bigint,
  check (char_length(action) between 1 and 64),
  check (char_length(summary) between 1 and 500)
);

create index idx_tool_executions_workspace
  on tool_executions (workspace_id, started_at desc);
create index idx_tool_executions_run
  on tool_executions (run_id, started_at)
  where run_id is not null;
create index idx_tool_executions_agent
  on tool_executions (agent_id, started_at desc);

create table tool_retention_policies (
  workspace_id              text primary key references workspaces(id) on delete cascade,
  artifact_retention_days   integer,
  max_artifact_bytes        bigint not null default 10485760,
  updated_by                text not null references actors(id),
  updated_at                bigint not null,
  check (artifact_retention_days is null or artifact_retention_days >= 1),
  check (max_artifact_bytes >= 1024)
);

alter table tool_executions enable row level security;
alter table tool_retention_policies enable row level security;
