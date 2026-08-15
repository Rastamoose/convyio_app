-- Board items can authorize a specific project. Existing items stay valid
-- with a null project_id so demos and older grants are unaffected.

alter table board_items
  add column if not exists project_id text references projects(id);

create index if not exists idx_board_items_project
  on board_items (project_id)
  where project_id is not null;

create table project_access_requests (
  id           text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id   text not null references projects(id) on delete cascade,
  agent_id     text not null references actors(id) on delete cascade,
  reason       text not null,
  status       text not null default 'pending'
    check (status in ('pending', 'approved', 'denied')),
  created_at   bigint not null,
  resolved_by  text references actors(id),
  resolved_at  bigint,
  check (char_length(reason) between 1 and 1000)
);

create unique index idx_project_access_pending
  on project_access_requests (project_id, agent_id)
  where status = 'pending';

create index idx_project_access_workspace
  on project_access_requests (workspace_id, status, created_at desc);

alter table project_access_requests enable row level security;
