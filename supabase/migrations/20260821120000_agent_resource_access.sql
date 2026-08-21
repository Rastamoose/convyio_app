create table agent_resource_grants (
  id             text primary key,
  workspace_id   text not null references workspaces(id) on delete cascade,
  agent_id        text not null references actors(id) on delete cascade,
  resource_kind   text not null
    check (resource_kind in ('channel', 'git_project', 'local_project', 'workspace_file')),
  resource_id     text not null,
  capability      text not null default 'content_read'
    check (capability = 'content_read'),
  granted_by      text not null references actors(id),
  reason          text not null,
  created_at      bigint not null,
  revoked_by      text references actors(id),
  revoked_at      bigint,
  check (char_length(resource_id) between 1 and 200),
  check (char_length(reason) between 1 and 1000),
  check ((revoked_by is null) = (revoked_at is null))
);

create unique index idx_agent_resource_grants_active
  on agent_resource_grants (workspace_id, agent_id, resource_kind, resource_id)
  where revoked_at is null;
create index idx_agent_resource_grants_agent
  on agent_resource_grants (workspace_id, agent_id, created_at desc);

create table agent_resource_access_requests (
  id                text primary key,
  workspace_id      text not null references workspaces(id) on delete cascade,
  agent_id           text not null references actors(id) on delete cascade,
  resource_kind      text not null
    check (resource_kind in ('channel', 'git_project', 'local_project', 'workspace_file')),
  resource_id        text not null,
  reason             text not null,
  status             text not null default 'pending'
    check (status in ('pending', 'approved', 'denied')),
  origin_channel_id  text references channels(id) on delete set null,
  created_at         bigint not null,
  resolved_by        text references actors(id),
  resolved_at        bigint,
  check (char_length(resource_id) between 1 and 200),
  check (char_length(reason) between 1 and 1000),
  check ((resolved_by is null) = (resolved_at is null))
);

create unique index idx_agent_resource_access_requests_pending
  on agent_resource_access_requests (workspace_id, agent_id, resource_kind, resource_id)
  where status = 'pending';
create index idx_agent_resource_access_requests_workspace
  on agent_resource_access_requests (workspace_id, status, created_at desc);

alter table agent_resource_grants enable row level security;
alter table agent_resource_access_requests enable row level security;
