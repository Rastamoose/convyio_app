-- CLI-like permission modes. These only change prompting; they never override
-- the hard safety ceiling (sandbox, identity, classified tools, owner).

alter table agent_conversations
  drop constraint if exists agent_conversations_permission_mode_check;

alter table agent_conversations
  add constraint agent_conversations_permission_mode_check
    check (permission_mode in ('default', 'plan', 'acceptEdits', 'approveAll', 'bypass'));
