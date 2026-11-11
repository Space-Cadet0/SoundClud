export * from './types.js';
export * from './fixtures.js';
export * from './mockMcuServer.js';
export * from './mockHeosCliServer.js';
export * from './mockUpnpServer.js';
export * from './mockHlsServer.js';
export * from './mockReceiverServer.js';
export * from './receiverProcessHarness.js';
export * from './syntheticDomEnvironment.js';

export interface ClosableResource {
  stop(): Promise<void>;
}

export async function stopAllResources(resources: readonly (ClosableResource | null | undefined)[]): Promise<void> {
  await Promise.all(
    resources.map(async (r) => {
      if (r) {
        try {
          await r.stop();
        } catch {
          // Best effort teardown
        }
      }
    }),
  );
}
