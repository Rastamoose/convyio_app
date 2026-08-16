alter table workspaces
  add column public_code text,
  add column created_by text references actors(id) on delete set null,
  add column updated_at bigint;

update workspaces
set public_code = 'CV-' || upper(substr(md5(id), 1, 10)),
    updated_at = created_at;

alter table workspaces
  alter column public_code set not null,
  alter column public_code set default ('CV-' || upper(substr(md5(gen_random_uuid()::text), 1, 10))),
  alter column updated_at set not null,
  alter column updated_at set default ((extract(epoch from now()) * 1000)::bigint),
  add constraint workspaces_public_code_short
    check (char_length(public_code) between 6 and 32);

create unique index idx_workspaces_public_code on workspaces (public_code);
drop index idx_workspaces_name_lower;
create index idx_workspaces_name_lower on workspaces (lower(name));

alter table workspace_members
  add column role text not null default 'member'
    check (role in ('owner', 'member'));

update workspace_members m
set role = 'owner'
from actors a
where a.id = m.actor_id and a.kind = 'human';

create index idx_workspace_members_actor
  on workspace_members (actor_id, joined_at);
create unique index idx_actors_human_display_name_lower
  on actors (lower(display_name)) where kind = 'human';

alter table channels add column workspace_id text;
alter table messages add column workspace_id text;
alter table message_reactions add column workspace_id text;
alter table attachments
  add column workspace_id text,
  add column storage_key text;

update channels
set workspace_id = (select id from workspaces order by created_at, id limit 1)
where workspace_id is null;

update messages m
set workspace_id = c.workspace_id
from channels c
where c.id = m.channel_id and m.workspace_id is null;

update messages
set workspace_id = (select id from workspaces order by created_at, id limit 1)
where workspace_id is null;

update message_reactions r
set workspace_id = m.workspace_id
from messages m
where m.id = r.message_id and r.workspace_id is null;

update message_reactions
set workspace_id = (select id from workspaces order by created_at, id limit 1)
where workspace_id is null;

update attachments a
set workspace_id = m.workspace_id
from messages m
where m.id = a.message_id and a.workspace_id is null;

update attachments
set workspace_id = (select id from workspaces order by created_at, id limit 1)
where workspace_id is null;

update attachments set storage_key = id where storage_key is null;

alter table channels
  alter column workspace_id set not null,
  add constraint channels_workspace_id_fkey
    foreign key (workspace_id) references workspaces(id);

alter table messages
  alter column workspace_id set not null,
  add constraint messages_workspace_id_fkey
    foreign key (workspace_id) references workspaces(id);

alter table message_reactions
  alter column workspace_id set not null,
  add constraint message_reactions_workspace_id_fkey
    foreign key (workspace_id) references workspaces(id);

alter table attachments
  alter column workspace_id set not null,
  alter column storage_key set not null,
  add constraint attachments_workspace_id_fkey
    foreign key (workspace_id) references workspaces(id);

drop index idx_channels_name_lower;
create unique index idx_channels_workspace_name_lower
  on channels (workspace_id, lower(name));
create unique index idx_channels_workspace_id
  on channels (workspace_id, id);
create unique index idx_messages_workspace_id
  on messages (workspace_id, id);

alter table messages
  add constraint messages_workspace_channel_fkey
    foreign key (workspace_id, channel_id)
    references channels(workspace_id, id);

alter table message_reactions
  add constraint message_reactions_workspace_message_fkey
    foreign key (workspace_id, message_id)
    references messages(workspace_id, id)
    not valid;

create unique index idx_attachments_storage_key on attachments (storage_key);
create index idx_channels_workspace_active
  on channels (workspace_id, archived_at, created_at, seq);
create index idx_messages_workspace_channel_created
  on messages (workspace_id, channel_id, created_at, seq);
create index idx_message_reactions_workspace_message
  on message_reactions (workspace_id, message_id, created_at, seq);
create index idx_attachments_workspace_message
  on attachments (workspace_id, message_id);

create table workspace_invites (
  id           text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  token_hash   text not null,
  created_by   text not null references actors(id),
  created_at   bigint not null,
  expires_at   bigint not null,
  consumed_by  text references actors(id),
  consumed_at  bigint,
  revoked_at   bigint,
  check (expires_at > created_at),
  check (
    (consumed_by is null and consumed_at is null) or
    (consumed_by is not null and consumed_at is not null)
  ),
  check (consumed_at is null or consumed_at >= created_at),
  check (revoked_at is null or revoked_at >= created_at)
);

create unique index idx_workspace_invites_token_hash
  on workspace_invites (token_hash);
create index idx_workspace_invites_workspace_active
  on workspace_invites (workspace_id, expires_at)
  where consumed_at is null and revoked_at is null;
create index idx_workspace_invites_created_by
  on workspace_invites (created_by, created_at desc);

create table workspace_access_requests (
  id             text primary key,
  workspace_id   text not null references workspaces(id) on delete cascade,
  requester_id   text not null references actors(id),
  message        text,
  status         text not null default 'pending'
    check (status in ('pending', 'approved', 'denied')),
  created_at     bigint not null,
  resolved_by    text references actors(id),
  resolved_at    bigint,
  check (message is null or char_length(message) <= 2000),
  check (
    (status = 'pending' and resolved_by is null and resolved_at is null) or
    (status in ('approved', 'denied') and resolved_by is not null and resolved_at is not null)
  ),
  check (resolved_at is null or resolved_at >= created_at)
);

create unique index idx_workspace_access_requests_pending
  on workspace_access_requests (workspace_id, requester_id)
  where status = 'pending';
create index idx_workspace_access_requests_workspace_status
  on workspace_access_requests (workspace_id, status, created_at desc);
create index idx_workspace_access_requests_requester
  on workspace_access_requests (requester_id, created_at desc);

alter table workspace_invites enable row level security;
alter table workspace_access_requests enable row level security;
