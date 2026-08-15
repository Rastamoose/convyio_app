-- Logical workspace projects and the machine-level Toolman nodes that mount them.
-- Absolute checkout paths stay on the node; the server only stores opaque keys.

create table projects (
  id              text primary key,
  workspace_id    text not null references workspaces(id) on delete cascade,
  name            text not null,
  kind            text not null check (kind in ('git', 'directory')),
  remote_url      text,
  default_branch  text,
  created_by      text not null references actors(id),
  created_at      bigint not null,
  archived_at     bigint,
  unique (workspace_id, name),
  check (char_length(name) between 1 and 80),
  check (remote_url is null or char_length(remote_url) <= 500),
  check (default_branch is null or char_length(default_branch) between 1 and 200)
);

create index idx_projects_workspace
  on projects (workspace_id, archived_at, created_at desc);

create table toolman_nodes (
  id                 text primary key,
  workspace_id       text not null references workspaces(id) on delete cascade,
  name               text not null,
  token_hash         text not null unique,
  created_by         text not null references actors(id),
  created_at         bigint not null,
  last_connected_at  bigint,
  revoked_at         bigint,
  unique (workspace_id, name),
  check (char_length(name) between 1 and 80)
);

create index idx_toolman_nodes_workspace
  on toolman_nodes (workspace_id, revoked_at, created_at desc);

create table toolman_pairings (
  id           text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  node_name    text not null,
  token_hash   text not null unique,
  created_by   text not null references actors(id),
  created_at   bigint not null,
  expires_at   bigint not null,
  consumed_at  bigint,
  revoked_at   bigint,
  check (char_length(node_name) between 1 and 80)
);

create index idx_toolman_pairings_workspace
  on toolman_pairings (workspace_id, created_at desc);

create table project_mounts (
  id             text primary key,
  project_id     text not null references projects(id) on delete cascade,
  node_id        text not null references toolman_nodes(id) on delete cascade,
  mount_key      text not null,
  head_revision  text,
  branch         text,
  cleanliness    text not null default 'unknown'
    check (cleanliness in ('clean', 'dirty', 'unknown')),
  created_at     bigint not null,
  updated_at     bigint not null,
  unique (node_id, project_id),
  unique (node_id, mount_key),
  check (char_length(mount_key) between 1 and 128)
);

create index idx_project_mounts_project
  on project_mounts (project_id, node_id);

create table project_assignments (
  project_id     text not null references projects(id) on delete cascade,
  agent_id       text not null references actors(id) on delete cascade,
  mount_id       text not null references project_mounts(id) on delete cascade,
  assigned_by    text not null references actors(id),
  assigned_at    bigint not null,
  checkout_key   text not null,
  branch         text,
  base_revision  text,
  status         text not null default 'pending'
    check (status in ('pending', 'ready', 'error', 'offline')),
  last_error     text,
  updated_at     bigint not null,
  primary key (project_id, agent_id),
  unique (mount_id, checkout_key),
  check (char_length(checkout_key) between 1 and 128)
);

create index idx_project_assignments_agent
  on project_assignments (agent_id, status);

alter table projects enable row level security;
alter table toolman_nodes enable row level security;
alter table toolman_pairings enable row level security;
alter table project_mounts enable row level security;
alter table project_assignments enable row level security;
