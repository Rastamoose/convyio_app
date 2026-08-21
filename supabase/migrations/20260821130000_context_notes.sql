create table context_notes (
  id             text primary key,
  workspace_id   text not null references workspaces(id) on delete cascade,
  scope          text not null check (scope in ('workspace', 'agent')),
  agent_id        text references actors(id) on delete cascade,
  body            text not null,
  created_by      text not null references actors(id),
  created_at      bigint not null,
  superseded_by   text references context_notes(id),
  check (char_length(body) between 1 and 4000),
  check ((scope = 'workspace' and agent_id is null) or (scope = 'agent' and agent_id is not null))
);

create index idx_context_notes_workspace_active
  on context_notes (workspace_id, scope, created_at asc)
  where superseded_by is null;
create index idx_context_notes_agent_active
  on context_notes (workspace_id, agent_id, created_at asc)
  where scope = 'agent' and superseded_by is null;

alter table context_notes enable row level security;
