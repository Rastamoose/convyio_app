-- supabase/migrations/20260812120000_workspaces.sql
--
-- The workspace becomes a first-class named entity and registration
-- separates from identity: `actors` is now global (Supabase Auth ids for
-- humans), and `workspace_members` records who is registered into a
-- workspace. Everything that was scoped by the nameless meta server_id
-- renames to workspace_id.

create table workspaces (
  id          text primary key,
  name        text not null,
  created_at  bigint not null
);

create unique index idx_workspaces_name_lower on workspaces (lower(name));

-- Seed from the legacy meta row so existing data keeps its ids.
insert into workspaces (id, name, created_at)
select value, 'test_space', (extract(epoch from now()) * 1000)::bigint
from meta where key = 'server_id';

create table workspace_members (
  workspace_id  text not null references workspaces(id),
  actor_id      text not null references actors(id),
  joined_at     bigint not null,
  primary key (workspace_id, actor_id)
);

-- Backfill membership for registered participants only: agents, and humans
-- that came through Supabase signup (those always have an email). Demo
-- personas and guest human actors have email null and are not members.
insert into workspace_members (workspace_id, actor_id, joined_at)
select a.server_id, a.id, (extract(epoch from now()) * 1000)::bigint
from actors a
join workspaces w on w.id = a.server_id
where a.kind = 'agent' or a.email is not null;

-- actors becomes the global identity table. Dropping the column also drops
-- idx_actors_server_kind_name; idx_actors_email stays as-is.
alter table actors drop column server_id;

create index idx_actors_kind_name on actors (kind, lower(display_name));

alter table board_items rename column server_id to workspace_id;
alter table board_events rename column server_id to workspace_id;
alter table ref_counters rename column server_id to workspace_id;

alter index idx_items_server_status rename to idx_items_workspace_status;
alter index idx_events_server_created rename to idx_events_workspace_created;

-- The meta table's only row was the server_id, now living in workspaces.
drop table meta;

-- Deny-all through PostgREST, matching 20260812090000_enable_rls.sql.
alter table workspaces         enable row level security;
alter table workspace_members  enable row level security;
