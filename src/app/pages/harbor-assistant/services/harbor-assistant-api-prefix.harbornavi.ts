export function harborAssistantBeaconApiUrl(path: string): string {
  return `/api/beacon${path}`;
}

export function harborAssistantGateApiUrl(path: string): string {
  return `/api/beacon${path}`;
}

export function harborAssistantGateRequiresUserToken(): boolean {
  return false;
}
