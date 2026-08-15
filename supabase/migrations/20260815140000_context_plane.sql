-- Canonical planning and shared-context foundation. Existing board items stay
-- valid: plan_id is nullable until the Ticket lifecycle ticket backfills
-- them. New tables follow the workspace-wide deny-all RLS convention.

create table board_plans (
  id                   text primary key,
  workspace_id         text not null references workspaces(id) on delete cascade,
  ref                  text not null,
  title                text not null,
  objective            text not null,
  outline              jsonb not null default '[]'::jsonb,
  impact_map           jsonb not null default '{}'::jsonb,
  constraints          jsonb not null default '[]'::jsonb,
  decisions            jsonb not null default '[]'::jsonb,
  acceptance_criteria  jsonb not null default '[]'::jsonb,
  status               text not null default 'draft'
    check (status in ('draft', 'proposed', 'accepted', 'completed', 'cancelled')),
  created_by           text not null references actors(id),
  accepted_by          text references actors(id),
  created_at           bigint not null,
  accepted_at          bigint,
  completed_at         bigint,
  unique (workspace_id, ref)
);

create index idx_board_plans_workspace_status
  on board_plans (workspace_id, status, created_at desc);

alter table board_items
  add column if not exists plan_id text references board_plans(id),
  add column if not exists acceptance_criteria jsonb not null default '[]'::jsonb,
  add column if not exists verification_evidence text;

create index if not exists idx_board_items_plan
  on board_items (plan_id)
  where plan_id is not null;

create table context_entries (
  id            text primary key,
  workspace_id  text not null references workspaces(id) on delete cascade,
  kind          text not null
    check (kind in ('decision', 'constraint', 'fact', 'blocker', 'handoff', 'summary')),
  scope         text not null
    check (scope in ('workspace', 'plan', 'ticket', 'channel')),
  subject_id    text,
  body          text not null,
  created_by    text not null references actors(id),
  superseded_by text references context_entries(id),
  created_at    bigint not null,
  check (
    (scope = 'workspace' and subject_id is null) or
    (scope <> 'workspace' and subject_id is not null)
  )
);

create index idx_context_entries_workspace_active
  on context_entries (workspace_id, created_at desc)
  where superseded_by is null;
create index idx_context_entries_subject
  on context_entries (workspace_id, scope, subject_id)
  where subject_id is not null;

create table context_cursors (
  workspace_id       text not null references workspaces(id) on delete cascade,
  actor_id           text not null references actors(id) on delete cascade,
  acknowledged_seq   bigint not null default 0,
  acknowledged_at    bigint not null,
  last_envelope_id   text,
  primary key (workspace_id, actor_id)
);

alter table board_plans enable row level security;
alter table context_entries enable row level security;
alter table context_cursors enable row level security;
