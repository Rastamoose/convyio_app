-- Agent notebook entries (scope='agent') were visible to that agent in every
-- channel it operates in, with no way to scope a note to the channel it was
-- written about. That let stale task-specific notes (e.g. "committed and
-- pushed X") bleed into unrelated channels and read like a live instruction.
alter table context_notes add column channel_id text references channels(id) on delete set null;

create index idx_context_notes_agent_channel_active
  on context_notes (workspace_id, agent_id, channel_id, created_at asc)
  where scope = 'agent' and superseded_by is null;
