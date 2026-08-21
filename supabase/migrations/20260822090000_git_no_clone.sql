-- Managed (GitHub App) repos no longer keep a server-side clone. Reads and
-- writes go straight through the GitHub API; edits are staged here until an
-- agent commit freezes them into a pending, not-yet-pushed commit object,
-- and a human push moves the branch ref onto it.

alter table git_repositories
  add column working_branch text;

update git_repositories set working_branch = default_branch where working_branch is null;

alter table git_repositories
  alter column working_branch set not null;

create table git_pending_commits (
  id            text primary key,
  project_id    text not null references git_repositories(project_id) on delete cascade,
  branch        text not null,
  message       text not null,
  author_id     text not null references actors(id),
  commit_sha    text not null,
  parent_sha    text not null,
  created_at    bigint not null
);

create index idx_git_pending_commits_project
  on git_pending_commits (project_id, created_at);

create table git_changes (
  id                 bigserial primary key,
  project_id         text not null references git_repositories(project_id) on delete cascade,
  pending_commit_id  text references git_pending_commits(id) on delete cascade,
  path               text not null,
  kind               text not null check (kind in ('upsert', 'delete')),
  content            text,
  created_at         bigint not null,
  check (kind = 'upsert' or content is null)
);

create unique index idx_git_changes_staged_path
  on git_changes (project_id, path)
  where pending_commit_id is null;

create index idx_git_changes_pending_commit
  on git_changes (pending_commit_id);

alter table git_pending_commits enable row level security;
alter table git_changes enable row level security;
