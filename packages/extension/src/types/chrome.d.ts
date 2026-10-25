/**
 * Minimal, zero-`any` ambient TypeScript declarations for Chromium Manifest V3
 * APIs (`chrome >= 116`) used by `@soundclud/extension`.
 */

declare namespace chrome {
  namespace storage {
    type AreaName = 'local' | 'session' | 'sync' | 'managed';

    interface StorageChange {
      readonly oldValue?: unknown;
      readonly newValue?: unknown;
    }

    interface StorageArea {
      get(
        keys?: string | readonly string[] | Record<string, unknown> | null,
      ): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | readonly string[]): Promise<void>;
      clear(): Promise<void>;
    }

    interface StorageChangedEvent {
      addListener(
        callback: (
          changes: Record<string, StorageChange>,
          areaName: AreaName,
        ) => void,
      ): void;
      removeListener(
        callback: (
          changes: Record<string, StorageChange>,
          areaName: AreaName,
        ) => void,
      ): void;
    }

    const local: StorageArea;
    const session: StorageArea;
    const onChanged: StorageChangedEvent;
  }

  namespace tabs {
    interface Tab {
      readonly id?: number | undefined;
      readonly windowId?: number | undefined;
      readonly active?: boolean | undefined;
      readonly title?: string | undefined;
      readonly url?: string | undefined;
    }

    interface TabRemovedRemoveInfo {
      readonly windowId: number;
      readonly isWindowClosing: boolean;
    }

    interface TabRemovedEvent {
      addListener(
        callback: (tabId: number, removeInfo: TabRemovedRemoveInfo) => void,
      ): void;
      removeListener(
        callback: (tabId: number, removeInfo: TabRemovedRemoveInfo) => void,
      ): void;
    }

    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    const onRemoved: TabRemovedEvent;
  }

  namespace runtime {
    interface MessageSender {
      readonly id?: string | undefined;
      readonly url?: string | undefined;
      readonly tab?: tabs.Tab | undefined;
      readonly frameId?: number | undefined;
    }

    interface InstalledDetails {
      readonly reason: 'install' | 'update' | 'chrome_update' | 'shared_module_update';
      readonly previousVersion?: string | undefined;
    }

    interface PortMessageEvent {
      addListener(callback: (message: unknown, port: Port) => void): void;
      removeListener(callback: (message: unknown, port: Port) => void): void;
    }

    interface PortDisconnectEvent {
      addListener(callback: (port: Port) => void): void;
      removeListener(callback: (port: Port) => void): void;
    }

    interface Port {
      readonly name: string;
      readonly sender?: MessageSender | undefined;
      postMessage(message: unknown): void;
      disconnect(): void;
      readonly onMessage: PortMessageEvent;
      readonly onDisconnect: PortDisconnectEvent;
    }

    interface ConnectInfo {
      readonly name?: string | undefined;
    }

    interface ExtensionMessageEvent {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
      removeListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    }

    interface ExtensionConnectEvent {
      addListener(callback: (port: Port) => void): void;
      removeListener(callback: (port: Port) => void): void;
    }

    interface InstalledEvent {
      addListener(callback: (details: InstalledDetails) => void | Promise<void>): void;
    }

    interface StartupEvent {
      addListener(callback: () => void | Promise<void>): void;
    }

    const id: string;
    const lastError: { readonly message?: string | undefined } | undefined;

    function sendMessage(message: unknown): Promise<unknown>;
    function connect(connectInfo?: ConnectInfo): Port;
    function getURL(path: string): string;

    const onMessage: ExtensionMessageEvent;
    const onConnect: ExtensionConnectEvent;
    const onInstalled: InstalledEvent;
    const onStartup: StartupEvent;
  }

  namespace alarms {
    interface Alarm {
      readonly name: string;
      readonly scheduledTime: number;
      readonly periodInMinutes?: number | undefined;
    }

    interface AlarmCreateInfo {
      readonly delayInMinutes?: number | undefined;
      readonly periodInMinutes?: number | undefined;
      readonly when?: number | undefined;
    }

    interface AlarmEvent {
      addListener(callback: (alarm: Alarm) => void | Promise<void>): void;
      removeListener(callback: (alarm: Alarm) => void | Promise<void>): void;
    }

    function create(name: string, alarmInfo: AlarmCreateInfo): Promise<void>;
    function clear(name: string): Promise<boolean>;
    function get(name: string): Promise<Alarm | undefined>;
    const onAlarm: AlarmEvent;
  }

  namespace action {
    interface BadgeTextDetails {
      readonly text: string;
      readonly tabId?: number | undefined;
    }

    interface BadgeBackgroundColorDetails {
      readonly color: string | readonly [number, number, number, number];
      readonly tabId?: number | undefined;
    }

    interface TitleDetails {
      readonly title: string;
      readonly tabId?: number | undefined;
    }

    function setBadgeText(details: BadgeTextDetails): Promise<void>;
    function setBadgeBackgroundColor(
      details: BadgeBackgroundColorDetails,
    ): Promise<void>;
    function setTitle(details: TitleDetails): Promise<void>;
  }
}
