-- supabase/migrations/20260809120000_init.sql

create table meta (
  key   text primary key,
  value text not null
);

create table actors (
  id            text primary key,
  kind          text not null check (kind in ('human', 'agent')),
  display_name  text not null,
  server_id     text not null,
  email         text
);

create unique index idx_actors_email on actors (lower(email)) where email is not null;
create index idx_actors_server_kind_name on actors (server_id, kind, lower(display_name));

create table board_items (
  id               text primary key,
  server_id        text not null,
  ref              text not null,
  title            text not null,
  description      text,
  status           text not null check (status in
    ('proposed', 'denied', 'approved', 'in_progress', 'blocked', 'done')),
  origin           text not null check (origin in ('human', 'agent')),
  created_by       text not null references actors(id),
  approved_by      text references actors(id),
  owner            text references actors(id),
  proposal_why     text,
  proposal_effect  text,
  scope_paths      text,
  created_at       bigint not null,
  approved_at      bigint,
  started_at       bigint,
  completed_at     bigint,
  deleted_at       bigint,
  unique (server_id, ref)
);

create table board_events (
  id          bigint generated always as identity primary key,
  server_id   text not null,
  item_id     text not null references board_items(id),
  type        text not null,
  actor_id    text not null references actors(id),
  payload     text not null default '{}',
  created_at  bigint not null
);

create table ref_counters (
  server_id  text primary key,
  n          integer not null
);

create table channels (
  id          text primary key,
  name        text not null,
  created_by  text references actors(id),
  is_demo     boolean not null default false,
  archived_at bigint,
  pinned_at   bigint,
  created_at  bigint not null,
  seq         bigint generated always as identity
);

create unique index idx_channels_name_lower on channels (lower(name));

create table messages (
  id           text primary key,
  author_id    text not null,
  author_name  text not null,
  author_kind  text not null check (author_kind in ('human', 'agent')),
  content      text not null,
  channel      text not null default 'general',
  run_id       text,
  trace        text,
  attachments  text,
  pinned_at    bigint,
  pinned_by    text,
  edited_at    bigint,
  reply_to_id  text,
  created_at   bigint not null,
  seq          bigint generated always as identity
);

create table message_reactions (
  message_id  text not null,
  emoji       text not null,
  actor_id    text not null,
  actor_name  text not null,
  created_at  bigint not null,
  seq         bigint generated always as identity,
  primary key (message_id, emoji, actor_id)
);

create table attachments (
  id           text primary key,
  uploader_id  text not null references actors(id),
  message_id   text,
  name         text not null,
  mime         text not null,
  size         integer not null,
  width        integer,
  height       integer,
  created_at   bigint not null
);

create index idx_items_server_status on board_items (server_id, status);
create index idx_events_server_created on board_events (server_id, created_at);
create index idx_messages_channel_created on messages (channel, created_at);
