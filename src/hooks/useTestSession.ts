import { useParams } from "@solidjs/router";
import { createSignal, onCleanup } from "solid-js";

import {
  diagTime,
  getOrCreateRelayUrl,
  getOrCreateStreamName,
  normalizePath,
} from "../helpers";
import type { DiagEvent } from "../types";

export function useTestSession() {
  const [diagLog, setDiagLog] = createSignal<DiagEvent[]>([]);
  const log = (tag: string, msg: string) => {
    const evt = { t: diagTime(), tag, msg };
    console.log(`[${evt.t}ms] [${tag}] ${msg}`);
    setDiagLog((prev) => [evt, ...prev].slice(0, 50));
  };

  const params = useParams<{ streamName?: string }>();
  const urlStream = () =>
    params.streamName?.toLowerCase().replace(/[^a-z0-9-]/g, "");

  const [roomName, setRoomName] = createSignal(
    urlStream() || getOrCreateStreamName(),
  );
  const [relayUrl, setRelayUrl] = createSignal(getOrCreateRelayUrl());
  const [watchPathOverride, setWatchPathOverride] = createSignal("");
  const [joinConfig, setJoinConfig] = createSignal<{
    relayUrl: string;
    roomName: string;
  }>();
  const [joining, setJoining] = createSignal(false);
  const [joined, setJoined] = createSignal(false);
  const [participants, setParticipants] = createSignal<string[]>([]);

  const broadcastId = crypto.randomUUID().slice(0, 8);

  const joinedRoomName = () => joinConfig()?.roomName ?? roomName();
  const joinedRelayUrl = () => joinConfig()?.relayUrl ?? relayUrl();
  const getRoomPrefix = (name: string) => `anon/${name}`;
  const getPublishName = (prefix: string) => `${prefix}/${broadcastId}`;
  const joinedRelayPath = () => getRoomPrefix(joinedRoomName());
  const localPublishPath = () => getPublishName(joinedRelayPath());

  const resolvedWatchName = () => {
    const override = normalizePath(watchPathOverride());
    if (override) return override;
    const remote = participants()[0];
    return remote ?? localPublishPath();
  };

  const resolvedSectionRelayUrl = () => {
    try {
      return new URL(joinedRelayUrl()).toString();
    } catch {
      return undefined;
    }
  };

  const addParticipant = (path: string) => {
    setParticipants((prev) => {
      if (prev.includes(path)) return prev;
      return [...prev, path];
    });
  };

  const removeParticipant = (path: string) => {
    setParticipants((prev) =>
      prev.filter((participant) => participant !== path),
    );
  };

  const handleNameChange = (value: string) => {
    const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setRoomName(clean);
    localStorage.setItem("moq-test-stream-name", clean);
  };

  const handleRelayUrlChange = (value: string) => {
    setRelayUrl(value);
    try {
      localStorage.setItem("moq-relay-url", new URL(value).toString());
    } catch {
      // Ignore partial/invalid input while the user is still typing.
    }
  };

  const handleJoin = () => {
    setJoining(true);

    const currentRelayUrl = relayUrl().trim();
    const currentRoomName = roomName().trim();
    if (!currentRelayUrl || !currentRoomName) {
      log("conn", "relay URL and room are required");
      setJoining(false);
      return;
    }

    let url: URL;
    try {
      url = new URL(currentRelayUrl);
    } catch {
      log("conn", "invalid relay URL");
      setJoining(false);
      return;
    }

    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocalhost) {
      log("conn", "relay URL must use https:// for WebTransport");
      setJoining(false);
      return;
    }

    const relayPath = getRoomPrefix(currentRoomName);
    const publishName = getPublishName(relayPath);

    const normalizedRelayUrl = url.toString();
    setRelayUrl(normalizedRelayUrl);
    localStorage.setItem("moq-relay-url", normalizedRelayUrl);
    setParticipants([]);
    setJoinConfig({ relayUrl: normalizedRelayUrl, roomName: currentRoomName });

    log("conn", `join room prefix: ${relayPath}`);
    log("conn", `join publish name: ${publishName}`);

    setJoined(true);
    setJoining(false);
  };

  const handleLeave = () => {
    setParticipants([]);
    setJoinConfig(undefined);
    setJoined(false);
    log("conn", "disconnected");
  };

  const handleBeforeUnload = () => {
    log("conn", "beforeunload -> leave");
    handleLeave();
  };

  window.addEventListener("beforeunload", handleBeforeUnload);

  onCleanup(() => {
    window.removeEventListener("beforeunload", handleBeforeUnload);
    handleLeave();
  });

  return {
    diagLog,
    handleJoin,
    handleLeave,
    handleNameChange,
    handleRelayUrlChange,
    joined,
    joinedRelayPath,
    joinedRelayUrl,
    joinedRoomName,
    joining,
    localPublishPath,
    log,
    participants,
    relayUrl,
    resolvedSectionRelayUrl,
    resolvedWatchName,
    roomName,
    setWatchPathOverride,
    watchPathOverride,
  };
}
