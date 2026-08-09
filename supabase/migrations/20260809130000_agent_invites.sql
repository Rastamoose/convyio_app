-- User-created agent invites. Each row grants one agent process the right
-- to join using a single token; revoking it removes the invite but keeps
-- the actor row for attribution.

create table agent_invites (
  id            text primary key,
  token_hash    text not null,
  actor_id      text not null references actors(id),
  created_by    text not null references actors(id),
  provider      text not null,
  created_at    bigint not null,
  revoked_at    bigint
);

create unique index idx_agent_invites_token_hash on agent_invites (token_hash);
create index idx_agent_invites_actor on agent_invites (actor_id);
create index idx_agent_invites_created_by on agent_invites (created_by);
