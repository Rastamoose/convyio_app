-- Workspace-scoped agent profiles and install credentials.

alter table agent_invites
  add column workspace_id text references workspaces(id),
  add column instructions text not null default '',
  add column requested_model text,
  add column access_mode text not null default 'workspace'
    check (access_mode in ('workspace', 'creator', 'selected')),
  add column selected_actor_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(selected_actor_ids) = 'array'),
  add column config_revision bigint not null default 1,
  add column updated_at bigint;

update agent_invites i
set workspace_id = m.workspace_id
from workspace_members m
where m.actor_id = i.actor_id;

update agent_invites
set workspace_id = (select id from workspaces limit 1)
where workspace_id is null;

update agent_invites
set updated_at = created_at
where updated_at is null;

alter table agent_invites
  alter column workspace_id set not null,
  alter column updated_at set not null,
  add constraint agent_invites_instructions_bounded check (char_length(instructions) <= 20000),
  add constraint agent_invites_model_bounded check (requested_model is null or char_length(requested_model) between 1 and 200),
  add constraint agent_invites_revision_positive check (config_revision >= 1);

create index idx_agent_invites_workspace on agent_invites (workspace_id, created_at desc);

create table agent_pairings (
  id          text primary key,
  invite_id   text not null references agent_invites(id) on delete cascade,
  token_hash  text not null unique,
  created_by  text not null references actors(id),
  created_at  bigint not null,
  expires_at  bigint not null,
  consumed_at bigint,
  revoked_at  bigint
);

create index idx_agent_pairings_invite on agent_pairings (invite_id, created_at desc);

create table agent_installations (
  id           text primary key,
  invite_id    text not null references agent_invites(id) on delete cascade,
  token_hash   text not null unique,
  created_at   bigint not null,
  last_used_at bigint
);

create index idx_agent_installations_invite on agent_installations (invite_id, created_at desc);

alter table agent_pairings enable row level security;
alter table agent_installations enable row level security;
