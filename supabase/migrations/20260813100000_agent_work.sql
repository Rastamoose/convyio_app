-- Durable agent conversation and mention-delivery projections.

alter table messages
  add column mentions jsonb not null default '[]'::jsonb;

create table agent_conversations (
  id                   text primary key,
  workspace_id         text not null references workspaces(id),
  agent_id             text not null references actors(id),
  channel_id           text not null references channels(id) on delete cascade,
  provider_session_id  text,
  permission_mode      text not null default 'default'
    check (permission_mode in ('default', 'plan', 'acceptEdits')),
  status               text not null default 'active',
  created_at           bigint not null,
  updated_at           bigint not null,
  unique (workspace_id, agent_id, channel_id)
);

create table agent_run_requests (
  id               text primary key,
  workspace_id     text not null references workspaces(id),
  channel_id       text not null references channels(id) on delete cascade,
  agent_id         text not null references actors(id),
  message_id       text not null references messages(id) on delete cascade,
  conversation_id  text not null references agent_conversations(id) on delete cascade,
  status           text not null default 'queued'
    check (status in ('queued', 'claimed', 'completed', 'cancelled')),
  created_at       bigint not null,
  claimed_at       bigint,
  completed_at     bigint,
  unique (agent_id, message_id)
);

create index idx_agent_conversations_agent_status
  on agent_conversations (agent_id, status, updated_at);
create index idx_agent_run_requests_agent_status_created
  on agent_run_requests (agent_id, status, created_at, id);

alter table agent_conversations enable row level security;
alter table agent_run_requests enable row level security;
