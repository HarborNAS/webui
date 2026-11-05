import { HttpClient } from '@angular/common/http';
import { Injectable, Injector, inject } from '@angular/core';
import { Observable, defer, map, switchMap } from 'rxjs';
import { AuthService } from 'app/modules/auth/auth.service';
import {
  harborAssistantBeaconApiUrl,
  harborAssistantGateApiUrl,
  harborAssistantGateRequiresUserToken,
} from 'app/pages/harbor-assistant/services/harbor-assistant-api-prefix';
import { harborAssistantPreviewUrl } from 'app/pages/harbor-assistant/shared/harbor-assistant-results';
import {
  HarborAssistantCameraLiveSessionResponse,
  HarborAssistantConversationDetail,
  HarborAssistantConversationListResponse,
  HarborAssistantConversationSettings,
  HarborAssistantKnowledgeAnswerResponse,
  HarborAssistantKnowledgeSuggestionsResponse,
  HarborAssistantRetrievalSettings,
  HarborAssistantHarborLinkCapabilitiesResponse,
  HarborAssistantSearchCameraStateResponse,
  HarborAssistantSearchDvrStatusResponse,
  HarborAssistantSearchDvrTimelineResponse,
  HarborAssistantSearchRequest,
  HarborAssistantSearchResponse,
  HarborAssistantSearchSnapshotTaskResponse,
  HarborAssistantSearchWireResponse,
} from 'app/pages/harbor-assistant/shared/harbor-assistant.interface';

interface HarborAssistantAuthenticatedRequestOptions {
  headers?: Record<'X-HarborOS-Auth-Token', string>;
}

@Injectable({ providedIn: 'root' })
export class HarborAssistantContentApiService {
  private readonly http = inject(HttpClient);
  private readonly injector = inject(Injector);
  private readonly requestIdSeed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private requestSequence = 0;

  private apiUrl(path: string): string {
    return harborAssistantBeaconApiUrl(path);
  }

  private gateApiUrl(path: string): string {
    return harborAssistantGateApiUrl(path);
  }

  search(payload: HarborAssistantSearchRequest): Observable<HarborAssistantSearchResponse> {
    return this.withUserToken((options) => this.http.post<HarborAssistantSearchWireResponse>(
      this.gateApiUrl('/knowledge/search'),
      payload,
      options,
    )).pipe(
      map((response) => normalizeHarborAssistantSearchResponse(response, payload.conversation_id)),
    );
  }

  suggestions(): Observable<HarborAssistantKnowledgeSuggestionsResponse> {
    return this.http.get<HarborAssistantKnowledgeSuggestionsResponse>(
      this.apiUrl('/knowledge/suggestions'),
    );
  }

  conversations(): Observable<HarborAssistantConversationListResponse> {
    return this.withUserToken((options) => this.http.get<HarborAssistantConversationListResponse>(
      this.gateApiUrl('/knowledge/conversations'),
      options,
    ));
  }

  conversation(conversationId: string): Observable<HarborAssistantConversationDetail> {
    return this.withUserToken((options) => this.http.get<HarborAssistantConversationDetail>(
      this.gateApiUrl(`/knowledge/conversations/${encodeURIComponent(conversationId)}`),
      options,
    ));
  }

  deleteConversation(conversationId: string): Observable<{ deleted: boolean; conversation_id: string }> {
    return this.withUserToken((options) => this.http.delete<{ deleted: boolean; conversation_id: string }>(
      this.gateApiUrl(`/knowledge/conversations/${encodeURIComponent(conversationId)}`),
      options,
    ));
  }

  saveConversationSettings(
    settings: HarborAssistantConversationSettings,
  ): Observable<HarborAssistantConversationSettings> {
    return this.withUserToken((options) => this.http.patch<HarborAssistantConversationSettings>(
      this.gateApiUrl('/knowledge/conversation-settings'),
      settings,
      options,
    ));
  }

  retrievalSettings(): Observable<HarborAssistantRetrievalSettings> {
    return this.http.get<HarborAssistantRetrievalSettings>(this.apiUrl('/knowledge/retrieval-settings'));
  }

  saveRetrievalSettings(settings: HarborAssistantRetrievalSettings): Observable<HarborAssistantRetrievalSettings> {
    return this.http.patch<HarborAssistantRetrievalSettings>(
      this.apiUrl('/knowledge/retrieval-settings'),
      settings,
    );
  }

  cameraState(): Observable<HarborAssistantSearchCameraStateResponse> {
    return this.http.get<HarborAssistantSearchCameraStateResponse>(
      this.apiUrl('/state'),
    );
  }

  dvrStatus(): Observable<HarborAssistantSearchDvrStatusResponse> {
    return this.http.get<HarborAssistantSearchDvrStatusResponse>(
      this.apiUrl('/cameras/recordings/status'),
    );
  }

  dvrTimeline(
    deviceId?: string | null,
    from?: string | null,
    to?: string | null,
  ): Observable<HarborAssistantSearchDvrTimelineResponse> {
    const params = new URLSearchParams();
    if (deviceId) {
      params.set('device_id', deviceId);
    }
    if (from) {
      params.set('from', from);
    }
    if (to) {
      params.set('to', to);
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.http.get<HarborAssistantSearchDvrTimelineResponse>(
      this.apiUrl(`/cameras/recordings/timeline${query}`),
    );
  }

  startDvrRecording(
    deviceId: string,
    streamProfile: 'sub' | 'main',
  ): Observable<HarborAssistantSearchDvrStatusResponse> {
    return this.http.post<HarborAssistantSearchDvrStatusResponse>(
      this.apiUrl(`/cameras/${encodeURIComponent(deviceId)}/recordings/start`),
      { stream_profile: streamProfile },
      this.mutationOptions('recording-start', deviceId),
    );
  }

  stopDvrRecording(
    deviceId: string,
  ): Observable<HarborAssistantSearchDvrStatusResponse> {
    return this.http.post<HarborAssistantSearchDvrStatusResponse>(
      this.apiUrl(`/cameras/${encodeURIComponent(deviceId)}/recordings/stop`),
      {},
      this.mutationOptions('recording-stop', deviceId),
    );
  }

  startCameraLiveSession(
    deviceId: string,
    streamProfile = 'sub',
  ): Observable<HarborAssistantCameraLiveSessionResponse> {
    return this.http.post<HarborAssistantCameraLiveSessionResponse>(
      this.apiUrl(`/cameras/${encodeURIComponent(deviceId)}/live/start`),
      { stream_profile: streamProfile },
      this.mutationOptions('live-start', deviceId),
    );
  }

  stopCameraLiveSession(
    deviceId: string,
    sessionId?: string | null,
  ): Observable<HarborAssistantCameraLiveSessionResponse> {
    return this.http.post<HarborAssistantCameraLiveSessionResponse>(
      this.apiUrl(`/cameras/${encodeURIComponent(deviceId)}/live/stop`),
      sessionId ? { session_id: sessionId } : {},
      this.mutationOptions('live-stop', `${deviceId}:${sessionId ?? 'current'}`),
    );
  }

  renewCameraLiveSession(
    deviceId: string,
    sessionId: string,
    ttlSeconds = 300,
  ): Observable<HarborAssistantCameraLiveSessionResponse> {
    return this.http.post<HarborAssistantCameraLiveSessionResponse>(
      this.apiUrl(`/cameras/${encodeURIComponent(deviceId)}/live/renew`),
      { session_id: sessionId, ttl_seconds: ttlSeconds },
      this.mutationOptions('live-renew', `${deviceId}:${sessionId}`),
    );
  }

  cameraLiveStatus(
    deviceId: string,
    sessionId?: string | null,
  ): Observable<HarborAssistantCameraLiveSessionResponse> {
    const query = sessionId
      ? `?session_id=${encodeURIComponent(sessionId)}`
      : '';
    return this.http.get<HarborAssistantCameraLiveSessionResponse>(
      this.apiUrl(
        `/cameras/${encodeURIComponent(deviceId)}/live/status${query}`,
      ),
    );
  }

  harborLinkCapabilities(): Observable<HarborAssistantHarborLinkCapabilitiesResponse> {
    return this.http.get<HarborAssistantHarborLinkCapabilitiesResponse>(
      this.apiUrl('/harbor-link/capabilities'),
    );
  }

  createSnapshotTask(
    deviceId: string,
  ): Observable<HarborAssistantSearchSnapshotTaskResponse> {
    return this.http.post<HarborAssistantSearchSnapshotTaskResponse>(
      this.apiUrl(`/cameras/${encodeURIComponent(deviceId)}/snapshot`),
      {},
      this.mutationOptions('snapshot', deviceId),
    );
  }

  private mutationOptions(operation: string, entity: string): { headers: Record<string, string> } {
    this.requestSequence += 1;
    return {
      headers: {
        'X-Request-Id': `webui:${operation}:${entity}:${this.requestIdSeed}:${this.requestSequence}`,
      },
    };
  }

  previewUrl(path: string): string {
    return harborAssistantPreviewUrl(path);
  }

  private withUserToken<T>(
    request: (options: HarborAssistantAuthenticatedRequestOptions) => Observable<T>,
  ): Observable<T> {
    return defer(() => {
      if (!harborAssistantGateRequiresUserToken()) {
        return request({});
      }
      return this.injector.get(AuthService).getHarborAssistantOneTimeToken().pipe(
        switchMap((token) => request({
          headers: { 'X-HarborOS-Auth-Token': token },
        })),
      );
    });
  }
}

export function normalizeHarborAssistantSearchResponse(
  response: unknown,
  conversationId?: string,
): HarborAssistantSearchResponse {
  if (isHarborAssistantSearchResponse(response)) {
    return response;
  }
  if (!isHarborAssistantKnowledgeAnswerResponse(response)) {
    throw new Error('Harbor Assistant returned an unsupported search response.');
  }

  const degraded = response.degraded || response.search.degraded;
  const degradedReason = response.degraded_reason ?? response.search.degraded_reason ?? null;

  return {
    ...response.search,
    conversation_id: response.conversation_id ?? conversationId,
    answer: response.answer,
    degraded,
    degraded_reason: degradedReason,
    answer_degraded: degraded,
    answer_degraded_reason: degradedReason,
    answer_intent: response.query_understanding?.intent ?? null,
    review_scope: response.review_scope ?? response.search.review_scope ?? null,
    reply_pack: {
      ...response.search.reply_pack,
      summary: response.answer,
      citations: response.citations,
    },
    warnings: stableUnique([...response.search.warnings, ...response.warnings]),
  };
}

function isHarborAssistantKnowledgeAnswerResponse(
  response: unknown,
): response is HarborAssistantKnowledgeAnswerResponse {
  if (!isRecord(response)) {
    return false;
  }
  return response.kind === 'rag.answer'
    && typeof response.query === 'string'
    && typeof response.answer === 'string'
    && typeof response.status === 'string'
    && typeof response.degraded === 'boolean'
    && Array.isArray(response.citations)
    && isStringArray(response.warnings)
    && isHarborAssistantSearchResponse(response.search);
}

function isHarborAssistantSearchResponse(response: unknown): response is HarborAssistantSearchResponse {
  if (!isRecord(response) || !isRecord(response.reply_pack)) {
    return false;
  }
  return typeof response.query === 'string'
    && Array.isArray(response.roots)
    && typeof response.total_matches === 'number'
    && Array.isArray(response.documents)
    && Array.isArray(response.images)
    && Array.isArray(response.videos)
    && typeof response.reply_pack.summary === 'string'
    && Array.isArray(response.reply_pack.citations)
    && Array.isArray(response.supported_modalities)
    && Array.isArray(response.pending_modalities)
    && typeof response.status === 'string'
    && typeof response.degraded === 'boolean'
    && isStringArray(response.blockers)
    && isStringArray(response.warnings)
    && Array.isArray(response.source_scope)
    && typeof response.privacy_level === 'string'
    && typeof response.resource_profile === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function stableUnique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}
