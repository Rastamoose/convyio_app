import { useEffect, useRef, useState } from "react";
import type { ClientEvent, Participant, ServerEvent } from "@workspace/shared";
import { WorkspaceSocket } from "../ws";

/**
 * The websocket session: owns the WorkspaceSocket lifecycle and everything
 * the welcome/presence frames carry — who I am, who else is here, which
 * channels exist. Events it does not own are forwarded to `onEvent`.
 */
export function useConnection(
  name: string,
  onEvent: (event: ServerEvent) => void,
) {
  const socketRef = useRef<WorkspaceSocket | null>(null);
  // Latest-callback ref so the connect effect only re-runs on name changes.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const [self, setSelf] = useState<Participant | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [demoChannels, setDemoChannels] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = new WorkspaceSocket();
    socketRef.current = socket;

    const unsubscribeEvents = socket.onEvent((event) => {
      switch (event.type) {
        case "welcome":
          setSelf(event.self);
          setParticipants(event.participants);
          setChannels(event.channels);
          setDemoChannels(event.demoChannels);
          setConnected(true);
          break;
        case "presence_sync":
          setParticipants(event.participants);
          break;
      }
      onEventRef.current(event);
    });
    const unsubscribeDisconnect = socket.onDisconnect(() =>
      setConnected(false),
    );

    socket.connect(name);

    return () => {
      unsubscribeEvents();
      unsubscribeDisconnect();
      socket.close();
      socketRef.current = null;
    };
  }, [name]);

  return {
    self,
    participants,
    channels,
    demoChannels,
    connected,
    send: (event: ClientEvent) => socketRef.current?.send(event),
  };
}
