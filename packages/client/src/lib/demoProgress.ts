import type { DemoProgressEvent } from "@workspace/shared";

export type DemoProgressState = Omit<DemoProgressEvent, "type">;

export function projectDemoProgress(event: DemoProgressEvent): DemoProgressState {
  return {
    channel: event.channel,
    stage: event.stage,
    message: event.message,
    paused: event.paused,
    ...(event.focus ? { focus: event.focus } : {}),
  };
}
