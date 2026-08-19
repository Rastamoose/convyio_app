create table git_connections (
  id                text primary key,
  actor_id          text not null references actors(id) on delete cascade,
  provider          text not null check (provider in ('github')),
  provider_user_id  text not null,
  login             text not null,
  display_name      text not null,
  avatar_url        text,
  token_ciphertext          text not null,
  refresh_token_ciphertext  text,
  token_expires_at          bigint,
  scopes                    text[] not null default '{}',
  created_at        bigint not null,
  updated_at        bigint not null,
  revoked_at        bigint,
  unique (actor_id, provider),
  unique (provider, provider_user_id),
  check (char_length(login) between 1 and 200),
  check (char_length(display_name) between 1 and 300)
);

create index idx_git_connections_actor
  on git_connections (actor_id, revoked_at);

alter table projects
  add constraint projects_id_workspace_unique unique (id, workspace_id);

create table git_repositories (
  project_id              text primary key,
  workspace_id            text not null,
  connection_id           text not null references git_connections(id),
  provider                text not null check (provider in ('github')),
  provider_repository_id  text not null,
  owner_name               text not null,
  repository_name          text not null,
  full_name                text not null,
  description              text,
  private                  boolean not null,
  default_branch           text not null,
  html_url                 text not null,
  clone_url                text not null,
  state                    text not null check (state in ('cloning', 'ready', 'error')),
  last_synced_at           bigint,
  last_error               text,
  linked_by                text not null references actors(id),
  linked_at                bigint not null,
  unlinked_at              bigint,
  foreign key (project_id, workspace_id)
    references projects(id, workspace_id) on delete cascade,
  unique (workspace_id, provider, provider_repository_id),
  check (char_length(owner_name) between 1 and 200),
  check (char_length(repository_name) between 1 and 200),
  check (char_length(full_name) between 3 and 401),
  check (char_length(default_branch) between 1 and 200)
);

create index idx_git_repositories_workspace
  on git_repositories (workspace_id, linked_at desc);

create table git_branch_channels (
  project_id   text not null references git_repositories(project_id) on delete cascade,
  branch       text not null,
  channel_id   text not null references channels(id) on delete cascade,
  created_at   bigint not null,
  archived_at  bigint,
  primary key (project_id, branch),
  unique (channel_id),
  check (char_length(branch) between 1 and 200)
);

alter table project_assignments alter column mount_id drop not null;
alter table tool_executions alter column mount_id drop not null;
alter table tool_executions alter column node_id drop not null;

alter table git_connections enable row level security;
alter table git_repositories enable row level security;
alter table git_branch_channels enable row level security;
