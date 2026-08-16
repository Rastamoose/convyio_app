alter table workspace_invites
  add column uses integer not null default 0,
  add column max_uses integer not null default 0;

update workspace_invites
set uses = case when consumed_at is null then 0 else 1 end,
    max_uses = case when consumed_at is null then 0 else 1 end;

drop index idx_workspace_invites_workspace_active;

alter table workspace_invites
  drop column consumed_by,
  drop column consumed_at,
  add constraint workspace_invites_uses_check check (uses >= 0),
  add constraint workspace_invites_max_uses_check check (max_uses >= 0),
  add constraint workspace_invites_use_limit_check check (max_uses = 0 or uses <= max_uses);

create index idx_workspace_invites_workspace_active
  on workspace_invites (workspace_id, expires_at)
  where revoked_at is null;
