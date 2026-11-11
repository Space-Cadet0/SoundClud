import type {
  DiscoveredOutput,
  OutputDevice,
  PlaybackTelemetry,
  ProtocolVersion,
  VolumeStatus,
} from '@soundclud/protocol';

export type PowerState = 'ON' | 'STANDBY';
export type McuInput = 'SINET' | 'SITV' | 'SICD';

export interface MockMcuServerOptions {
  readonly initialPower?: PowerState | undefined;
  readonly initialInput?: McuInput | undefined;
}

export interface MockMcuServer {
  readonly port: number;
  readonly baseUrl: string;
  setPowerState(state: PowerState): void;
  setInput(input: McuInput): void;
  getReceivedCommands(): readonly string[];
  assertZeroSleepCommands(): void;
  assertSerializedAccess(): void;
  simulateDisconnect(): void;
  stop(): Promise<void>;
}

export interface MockHeosCliServerOptions {
  readonly initialVolume?: number | undefined;
  readonly initialMuted?: boolean | undefined;
  readonly pid?: number | undefined;
}

export interface MockHeosCliServer {
  readonly port: number;
  readonly pid: number;
  readonly currentVolume: number;
  readonly currentMuted: boolean;
  setVolume(volume: number, muted?: boolean): void;
  setNextResult(result: 'success' | 'fail', message?: string): void;
  pushVolumeChangeEvent(volume: number, muted?: boolean): void;
  pushMuteOnlyChangeEvent(muted: boolean): void;
  getReceivedCommands(): readonly string[];
  simulateCommandUnderProcessDelay(ms: number): void;
  stop(): Promise<void>;
}

export interface MockUpnpServerOptions {
  readonly friendlyName?: string | undefined;
  readonly modelName?: string | undefined;
}

export interface MockUpnpServer {
  readonly port: number;
  readonly baseUrl: string;
  readonly descUrl: string;
  getCapturedStreamUri(): string;
  getCapturedDidlXml(): string;
  getReceivedSoapActions(): readonly string[];
  assertValidDidlMetadata(): void;
  assertZeroRenderingControlHits(): void;
  setTransportState(state: 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED'): void;
  setPositionMs(positionMs: number, durationMs: number): void;
  stop(): Promise<void>;
}

export interface MockHlsServerOptions {
  readonly defaultSegmentDurationSec?: number | undefined;
}

export interface MockHlsServer {
  readonly port: number;
  readonly baseUrl: string;
  getPlaylistUrl(options?: {
    trackDurationMs?: number | undefined;
    segmentDurationSec?: number | undefined;
  }): string;
  simulateSegmentError(statusCode: 403 | 404 | 500 | null): void;
  stop(): Promise<void>;
}

export interface MockReceiverServerOptions {
  readonly pairingToken?: string | undefined;
  readonly initialVolume?: number | undefined;
  readonly initialMuted?: boolean | undefined;
  readonly initialOutputs?: readonly OutputDevice[] | undefined;
  readonly requireAuthOnVolume?: boolean | undefined;
  readonly heosCliPort?: number | undefined;
  readonly mcuPort?: number | undefined;
  readonly outputEndpoints?: Record<string, { readonly cliPort: number; readonly mcuPort?: number | undefined }> | undefined;
}

export interface MockReceiverServer {
  readonly port: number;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly pairingToken: string;
  getVolume(): { volume: number; muted: boolean; supportsHardwareVolume: boolean };
  setVolume(volume: number, muted: boolean): void;
  broadcastVolumeChanged(volume: number, muted: boolean): void;
  broadcastOutputsUpdated(outputs: OutputDevice[]): void;
  broadcastStateTick(tick: {
    readonly state: 'playing' | 'paused' | 'stopped';
    readonly positionMs: number;
    readonly durationMs: number;
  }): void;
  broadcastTrackEnded(trackId: string, locatorId: string): void;
  simulateAuthTokenRequirement(requireAuth: boolean): void;
  getConnectedClientCount(): number;
  getLastSetVolumePayload(): { volume?: number | undefined; muted?: boolean | undefined } | null;
  triggerMcuKeepalive(): Promise<void>;
  stop(): Promise<void>;
}

export interface EphemeralReceiverOptions {
  readonly customArgs?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly heosSeedUrl?: string | undefined;
  readonly heosCliPort?: number | undefined;
  readonly mcuPort?: number | undefined;
}

export interface RunningReceiverDaemon {
  readonly port: number;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly stateDir: string;
  readonly mpvFetchedSegmentLogPath: string;
  fetchRest(path: string, init?: RequestInit): Promise<Response>;
  pair(clientLabel?: string, controllerId?: string): Promise<string>;
  connectWs(pairingToken?: string, controllerId?: string): Promise<WebSocket>;
  stop(): Promise<void>;
}
