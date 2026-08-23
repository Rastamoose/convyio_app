import type { DemoProgressEvent } from "@workspace/shared";

export type DemoProgressState = Omit<DemoProgressEvent, "type">;

export function projectDemoProgress(event: DemoProgressEvent): DemoProgressState {
  return {
    channel: event.channel,
    stage: event.stage,
    paused: event.paused,
    ...(event.message ? { message: event.message } : {}),
    ...(event.focus ? { focus: event.focus } : {}),
  };
}
