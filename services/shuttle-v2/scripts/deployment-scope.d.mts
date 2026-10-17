export function runtimeChanged(paths: string[]): boolean;
export function matchesProduction(build: string, options?: { cwd?: string; revision?: string }): boolean;
export function deploymentScope(options?: { before?: string; after?: string; cwd?: string; fetchMissing?: boolean }): {
  runtimeChanged: boolean; changedFiles: string[]; reason: string;
};
export function verifiedDeploymentScope(options?: {
  before?: string; after?: string; cwd?: string; fetchMissing?: boolean; fetchImpl?: typeof fetch;
}): Promise<{ runtimeChanged: boolean; changedFiles: string[]; reason: string; productionBuild?: string }>;
