import { useEffect, useRef, useState } from "react";
import type {
  ChannelInfo,
  ChannelSection,
  ClientEvent,
  Participant,
  ServerEvent,
  WorkspaceInfo,
} from "@workspace/shared";
import { WorkspaceSocket, type JoinCredentials } from "../ws";

/**
 * The websocket session: owns the WorkspaceSocket lifecycle and everything
 * the welcome/presence frames carry — who I am, who else is here, which
 * channels exist. Events it does not own are forwarded to `onEvent`.
 */
export function useConnection(
  credentials: JoinCredentials,
  onEvent: (event: ServerEvent) => void,
) {
  const socketRef = useRef<WorkspaceSocket | null>(null);
  // Latest-callback ref so the connect effect only re-runs when the join
  // credentials change.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [self, setSelf] = useState<Participant | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [channelInfos, setChannelInfos] = useState<ChannelInfo[]>([]);
  const [archivedChannels, setArchivedChannels] = useState<string[]>([]);
  const [pinnedChannels, setPinnedChannels] = useState<string[]>([]);
  const [channelSections, setChannelSections] = useState<ChannelSection[]>([]);
  const [demoChannels, setDemoChannels] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = new WorkspaceSocket();
    socketRef.current = socket;

    const unsubscribeEvents = socket.onEvent((event) => {
      switch (event.type) {
        case "welcome":
          setWorkspace(event.workspace);
          setSelf(event.self);
          setParticipants(event.participants);
          setChannels(event.channels);
          setChannelInfos(event.channelInfos ?? event.channels.map((name) => ({ id: name, name, sectionId: null })));
          setArchivedChannels(event.archivedChannels ?? []);
          setPinnedChannels(event.pinnedChannels ?? []);
          setChannelSections(event.channelSections ?? []);
          setDemoChannels(event.demoChannels);
          setConnected(true);
          break;
        case "presence_sync":
          setParticipants(event.participants);
          break;
        case "channel_created":
          setChannels((prev) =>
            prev.includes(event.channel) ? prev : [...prev, event.channel],
          );
          setChannelInfos((prev) =>
            prev.some((c) => c.name === event.channel)
              ? prev
              : [...prev, { id: event.channelInfo.id, name: event.channel, sectionId: event.channelInfo.sectionId ?? null }],
          );
          break;
        case "channel_renamed":
          setChannels((prev) => prev.map((c) => (c === event.oldName ? event.newName : c)));
          setChannelInfos((prev) =>
            prev.map((c) => (c.name === event.oldName ? { ...c, name: event.newName } : c)),
          );
          setArchivedChannels((prev) =>
            prev.map((c) => (c === event.oldName ? event.newName : c)),
          );
          setPinnedChannels((prev) =>
            prev.map((c) => (c === event.oldName ? event.newName : c)),
          );
          break;
        case "channel_archived":
          if (event.archived) {
            setChannels((prev) => prev.filter((c) => c !== event.channel));
            setPinnedChannels((prev) => prev.filter((c) => c !== event.channel));
            setArchivedChannels((prev) =>
              prev.includes(event.channel) ? prev : [event.channel, ...prev],
            );
          } else {
            setArchivedChannels((prev) => prev.filter((c) => c !== event.channel));
            setChannels((prev) =>
              prev.includes(event.channel) ? prev : [...prev, event.channel],
            );
          }
          break;
        case "channel_pinned":
          // Membership only; Sidebar sorts pinned channels to the top at render time.
          setPinnedChannels((prev) =>
            event.pinned
              ? prev.includes(event.channel)
                ? prev
                : [...prev, event.channel]
              : prev.filter((c) => c !== event.channel),
          );
          break;
        case "channel_deleted":
          setChannels((prev) => prev.filter((c) => c !== event.channel));
          setChannelInfos((prev) => prev.filter((c) => c.name !== event.channel));
          setArchivedChannels((prev) => prev.filter((c) => c !== event.channel));
          setPinnedChannels((prev) => prev.filter((c) => c !== event.channel));
          break;
        case "channel_section_created":
          setChannelSections((prev) =>
            prev.some((section) => section.id === event.section.id) ? prev : [...prev, event.section],
          );
          break;
        case "channel_moved":
          setChannelInfos((prev) =>
            prev.map((c) => (c.name === event.channel ? { ...c, sectionId: event.sectionId } : c)),
          );
          break;
      }
      onEventRef.current(event);
    });
    const unsubscribeDisconnect = socket.onDisconnect(() =>
      setConnected(false),
    );

    socket.connect(credentials);

    return () => {
      unsubscribeEvents();
      unsubscribeDisconnect();
      socket.close();
      socketRef.current = null;
    };
  }, [credentials.workspaceId, credentials.name, credentials.authToken]);

  return {
    workspace,
    self,
    participants,
    channels,
    channelInfos,
    archivedChannels,
    pinnedChannels,
    channelSections,
    demoChannels,
    connected,
    /** Sends a frame; returns false (without throwing) when the socket isn't usable. */
    send: (event: ClientEvent): boolean => {
      if (!connected) return false;
      socketRef.current?.send(event);
      return true;
    },
  };
}
