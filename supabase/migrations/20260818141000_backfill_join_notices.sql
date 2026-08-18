insert into messages (
  id, workspace_id, author_id, author_name, author_kind, content,
  channel, channel_id, mentions, created_at
)
select
  'member-joined:' || w.id || ':' || a.id,
  w.id,
  a.id,
  a.display_name,
  'system',
  a.display_name || ' joined the workspace',
  'general',
  c.id,
  '[]'::jsonb,
  m.joined_at
from workspace_members m
join workspaces w on w.id = m.workspace_id
join actors a on a.id = m.actor_id
join channels c on c.workspace_id = w.id and c.name = 'general'
where not exists (
  select 1 from messages existing
  where existing.id = 'member-joined:' || w.id || ':' || a.id
)
on conflict (id) do nothing;
