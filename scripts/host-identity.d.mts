export function selectedHost(minimum: string): {
  path: string;
  sha256: string;
  minimum: string;
  version: string;
};
export function mappedHost(): {
  path: string;
  sha256: string;
  fingerprint: string;
};
export function runtimeIdentity(bundle: string, host: string, minimum: string): string;
