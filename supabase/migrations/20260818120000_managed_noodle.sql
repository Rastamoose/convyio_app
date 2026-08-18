alter table actors
  add column managed_agent text,
  add constraint actors_managed_agent_check
    check (managed_agent is null or (kind = 'agent' and managed_agent = 'noodle'));

create index idx_actors_managed_agent on actors (managed_agent) where managed_agent is not null;

do $$
begin
  if exists (
    select 1
    from agent_invites i
    join actors a on a.id = i.actor_id
    join workspace_members m on m.actor_id = a.id and m.workspace_id = i.workspace_id
    where i.revoked_at is null and lower(a.display_name) = 'noodle'
  ) then
    raise exception 'A workspace already has an active invite-created agent named noodle; rename or revoke it before applying this migration';
  end if;
end $$;

with existing as (
  select distinct on (m.workspace_id) a.id
  from workspace_members m
  join actors a on a.id = m.actor_id
  where a.kind = 'agent' and lower(a.display_name) = 'noodle'
  order by m.workspace_id, a.id
)
update actors a
set managed_agent = 'noodle'
from existing e
where a.id = e.id;

insert into actors (id, kind, display_name, managed_agent)
select 'managed-agent:noodle:' || w.id, 'agent', 'noodle', 'noodle'
from workspaces w
where not exists (
  select 1
  from workspace_members m
  join actors a on a.id = m.actor_id
  where m.workspace_id = w.id and a.managed_agent = 'noodle'
);

insert into workspace_members (workspace_id, actor_id, role, joined_at)
select w.id, 'managed-agent:noodle:' || w.id, 'member',
       (extract(epoch from now()) * 1000)::bigint
from workspaces w
where not exists (
  select 1
  from workspace_members m
  join actors a on a.id = m.actor_id
  where m.workspace_id = w.id and a.managed_agent = 'noodle'
);

insert into messages (
  id, workspace_id, author_id, author_name, author_kind, content,
  channel, channel_id, mentions, created_at
)
select
  'managed-welcome:' || w.id || ':1', w.id, noodle.id, 'noodle', 'agent',
  'Hey ' || coalesce(owner_actor.display_name, 'there') || ' — I’m noodle, the little face in the tab and your built-in Convyio guide. I’m hosted by Convyio and free to use, so there’s nothing to install or keep running.',
  'general', general.id, '[]'::jsonb,
  (extract(epoch from now()) * 1000)::bigint
from workspaces w
join channels general on general.workspace_id = w.id and lower(general.name) = 'general'
join workspace_members noodle_member on noodle_member.workspace_id = w.id
join actors noodle on noodle.id = noodle_member.actor_id and noodle.managed_agent = 'noodle'
left join actors owner_actor on owner_actor.id = w.created_by
on conflict (id) do nothing;

insert into messages (
  id, workspace_id, author_id, author_name, author_kind, content,
  channel, channel_id, mentions, created_at
)
select
  'managed-welcome:' || w.id || ':2', w.id, noodle.id, 'noodle', 'agent',
  'This workspace is where people and agents figure things out together: chat here, shape work on the board, and approve what agents can actually change. You stay in charge.',
  'general', general.id, '[]'::jsonb,
  (extract(epoch from now()) * 1000)::bigint + 1
from workspaces w
join channels general on general.workspace_id = w.id and lower(general.name) = 'general'
join workspace_members noodle_member on noodle_member.workspace_id = w.id
join actors noodle on noodle.id = noodle_member.actor_id and noodle.managed_agent = 'noodle'
on conflict (id) do nothing;

insert into messages (
  id, workspace_id, author_id, author_name, author_kind, content,
  channel, channel_id, mentions, created_at
)
select
  'managed-welcome:' || w.id || ':3', w.id, noodle.id, 'noodle', 'agent',
  'Try `@noodle` with a question or small task. I’m quick and handy, but honestly not as capable as your own local Claude or Codex. When you want more power, hit **Add agent** in the sidebar. Owners can remove me any time by right-clicking my name.',
  'general', general.id, '[]'::jsonb,
  (extract(epoch from now()) * 1000)::bigint + 2
from workspaces w
join channels general on general.workspace_id = w.id and lower(general.name) = 'general'
join workspace_members noodle_member on noodle_member.workspace_id = w.id
join actors noodle on noodle.id = noodle_member.actor_id and noodle.managed_agent = 'noodle'
on conflict (id) do nothing;

insert into thread_events (
  id, workspace_id, channel_id, actor_id, kind, subject_id, payload, created_at
)
select
  'managed-welcome-event:' || m.workspace_id || ':' || right(m.id, 1),
  m.workspace_id,
  m.channel_id,
  m.author_id,
  'message.created',
  m.id,
  jsonb_build_object(
    'id', m.id,
    'authorId', m.author_id,
    'authorName', m.author_name,
    'authorKind', m.author_kind,
    'content', m.content,
    'timestamp', m.created_at,
    'channelId', m.channel_id,
    'channel', m.channel,
    'mentions', m.mentions
  ),
  m.created_at
from messages m
where m.id like 'managed-welcome:%'
on conflict (id) do nothing;
