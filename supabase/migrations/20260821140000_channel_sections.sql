-- Shared Discord-style channel sections. Ungrouped channels stay in the
-- implicit Rooms bucket (section_id IS NULL). Dropping a section returns
-- its channels there rather than deleting them.
create table channel_sections (
  id           text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name         text not null,
  created_by   text references actors(id),
  created_at   bigint not null,
  seq          bigint generated always as identity
);

create unique index idx_channel_sections_workspace_name_lower
  on channel_sections (workspace_id, lower(name));
create index idx_channel_sections_workspace
  on channel_sections (workspace_id, created_at, seq);

alter table channel_sections enable row level security;

alter table channels
  add column section_id text references channel_sections(id) on delete set null;
