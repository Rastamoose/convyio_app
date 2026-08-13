-- Preserve failed agent runs as a distinct terminal request state.

alter table agent_run_requests
  drop constraint agent_run_requests_status_check,
  add constraint agent_run_requests_status_check
    check (status in ('queued', 'claimed', 'completed', 'cancelled', 'failed'));
