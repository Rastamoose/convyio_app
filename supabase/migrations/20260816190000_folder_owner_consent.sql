-- A shared folder is the resource. Its owner — the human who attached it —
-- controls whether Toolman may touch it. Conversation permission modes never
-- widen this. Device registration remains transport, not a grant.
--
-- ask:     prompt the owner for each new run (default).
-- always:  skip prompts while the owner is online; still require presence.
-- deny:    refuse every local operation.

alter table projects
  add column access_mode text not null default 'ask'
    check (access_mode in ('ask', 'always', 'deny'));

-- Folder-owner prompts target one human. Untargeted rows stay conversation
-- permission prompts, which any human may still resolve.
alter table interaction_requests
  add column target_actor_id text references actors(id);
