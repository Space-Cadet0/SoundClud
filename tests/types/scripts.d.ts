declare module '*/scripts/package-extension.mjs' {
  export interface PackageExtensionOptions {
    readonly sourceDir?: string | undefined;
    readonly outDir?: string | undefined;
    readonly outputFile?: string | undefined;
  }

  export interface PackageExtensionResult {
    readonly zipPath: string;
    readonly sha256Path: string;
    readonly sha256: string;
    readonly version: string;
    readonly fileCount: number;
    readonly byteLength: number;
  }

  export function computeCrc32(buffer: Buffer): number;

  export function validateExtensionDist(sourceDir: string): {
    readonly name: string;
    readonly version: string;
    readonly manifest: Readonly<Record<string, unknown>>;
  };

  export function collectExtensionFiles(
    sourceDir: string,
  ): ReadonlyArray<{ readonly relativePath: string; readonly data: Buffer }>;

  export function buildDeterministicZip(
    entries: ReadonlyArray<{ readonly relativePath: string; readonly data: Buffer }>,
  ): Buffer;

  export function packageExtensionDirectory(
    options?: PackageExtensionOptions,
  ): PackageExtensionResult;
}
