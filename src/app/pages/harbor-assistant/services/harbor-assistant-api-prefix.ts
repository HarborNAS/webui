export function harborAssistantBeaconApiUrl(path: string): string {
  return `/api/harbor-beacon${path}`;
}

export function harborAssistantGateApiUrl(path: string): string {
  return `/api/harbor-gate/api/beacon${path}`;
}

export function harborAssistantGateRequiresUserToken(): boolean {
  return true;
}

export function harborAssistantRuntimeApiUrl(path: string): string {
  return `/api/harbor-llama${path}`;
}
