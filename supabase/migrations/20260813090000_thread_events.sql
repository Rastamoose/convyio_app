-- Canonical append-only activity stream. Projection tables remain in place;
-- their mutations append matching rows here in the same transaction.

alter table messages add column channel_id text;

-- Old deployments can contain messages from before channels were persisted.
-- Materialize those names first so every message can acquire a stable id.
insert into channels (id, name, created_by, is_demo, created_at)
select 'legacy-channel:' || md5(lower(m.channel)), m.channel, null, false, min(m.created_at)
from messages m
left join channels c on lower(c.name) = lower(m.channel)
where c.id is null
group by lower(m.channel), m.channel
on conflict (lower(name)) do nothing;

update messages m
set channel_id = c.id
from channels c
where lower(c.name) = lower(m.channel);

alter table messages alter column channel_id set not null;
alter table messages
  add constraint messages_channel_id_fkey foreign key (channel_id) references channels(id);

create index idx_messages_channel_id_created on messages (channel_id, created_at, seq);

create table thread_events (
  id               text primary key,
  seq              bigint generated always as identity unique,
  workspace_id     text not null references workspaces(id),
  -- The mutable channel catalog must not rewrite historical event grouping.
  channel_id       text,
  actor_id         text not null references actors(id),
  kind             text not null,
  conversation_id  text,
  run_id           text,
  subject_id       text,
  parent_id        text,
  client_event_id  text,
  payload          jsonb not null default '{}'::jsonb,
  created_at       bigint not null
);

create unique index idx_thread_events_actor_client_event
  on thread_events (actor_id, client_event_id)
  where client_event_id is not null;
create index idx_thread_events_workspace_channel_seq
  on thread_events (workspace_id, channel_id, seq desc);
create index idx_thread_events_workspace_seq
  on thread_events (workspace_id, seq desc);
create index idx_thread_events_workspace_run_seq
  on thread_events (workspace_id, run_id, seq desc)
  where run_id is not null;

alter table thread_events enable row level security;

-- messages.author_id intentionally has no FK. Preserve older orphaned message
-- attribution by restoring the minimal actor identity required by the canonical
-- stream before its actor FK is populated.
insert into actors (id, kind, display_name, email)
select distinct on (m.author_id)
  m.author_id, m.author_kind, m.author_name, null
from messages m
left join actors a on a.id = m.author_id
where a.id is null
order by m.author_id, m.created_at, m.seq
on conflict (id) do nothing;

-- Insert both compatibility histories as one ordered set so the new identity
-- sequence reflects the best chronology available from the old projections.
insert into thread_events (
  id, workspace_id, channel_id, actor_id, kind, conversation_id, run_id,
  subject_id, parent_id, client_event_id, payload, created_at
)
select
  source.id,
  source.workspace_id,
  source.channel_id,
  source.actor_id,
  source.kind,
  source.conversation_id,
  source.run_id,
  source.subject_id,
  source.parent_id,
  null,
  source.payload,
  source.created_at
from (
  select
    'message.created:' || m.id as id,
    w.id as workspace_id,
    m.channel_id,
    m.author_id as actor_id,
    'message.created'::text as kind,
    null::text as conversation_id,
    m.run_id,
    m.id as subject_id,
    m.reply_to_id as parent_id,
    jsonb_strip_nulls(jsonb_build_object(
      'messageId', m.id,
      'authorId', m.author_id,
      'authorName', m.author_name,
      'authorKind', m.author_kind,
      'content', m.content,
      'channel', m.channel,
      'channelId', m.channel_id,
      'timestamp', m.created_at,
      'runId', m.run_id,
      'trace', case when m.trace is null then null else m.trace::jsonb end,
      'attachments', case when m.attachments is null then null else m.attachments::jsonb end,
      'pinnedAt', m.pinned_at,
      'pinnedBy', m.pinned_by,
      'editedAt', m.edited_at,
      'replyToId', m.reply_to_id
    )) as payload,
    m.created_at
  from messages m
  cross join workspaces w

  union all

  select
    'board.event:' || e.id as id,
    e.workspace_id,
    null::text as channel_id,
    e.actor_id,
    e.type as kind,
    null::text as conversation_id,
    null::text as run_id,
    e.item_id as subject_id,
    null::text as parent_id,
    jsonb_build_object('itemId', i.id, 'itemRef', i.ref) || e.payload::jsonb as payload,
    e.created_at
  from board_events e
  join board_items i on i.id = e.item_id
) source
order by source.created_at, source.id;
