export function harborAssistantBeaconApiUrl(path: string): string {
  return `/api/harbor-beacon${path}`;
}

export function harborAssistantRuntimeApiUrl(path: string): string {
  return `/api/harbor-llama${path}`;
}
