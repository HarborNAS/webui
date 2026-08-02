import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { SpectatorService, createServiceFactory, mockProvider } from '@ngneat/spectator/jest';
import { firstValueFrom, of } from 'rxjs';
import { AuthService } from 'app/modules/auth/auth.service';
import { HarborAssistantContentApiService } from 'app/pages/harbor-assistant/shared/harbor-assistant-content-api.service';
import {
  HarborAssistantSearchRequest,
  HarborAssistantSearchResponse,
} from 'app/pages/harbor-assistant/shared/harbor-assistant.interface';

describe('Harbor Assistant content API service', () => {
  let spectator: SpectatorService<HarborAssistantContentApiService>;
  let httpMock: HttpTestingController;

  const createService = createServiceFactory({
    service: HarborAssistantContentApiService,
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      mockProvider(AuthService, {
        getHarborAssistantOneTimeToken: jest.fn(() => of('harbor-user-token')),
      }),
    ],
  });

  beforeEach(() => {
    spectator = createService();
    httpMock = spectator.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('loads prompt suggestions derived from the current knowledge index', async () => {
    const promise = firstValueFrom(spectator.service.suggestions());

    const req = httpMock.expectOne('/api/harbor-beacon/knowledge/suggestions');
    expect(req.request.method).toBe('GET');
    expect(spectator.inject(AuthService).getHarborAssistantOneTimeToken).not.toHaveBeenCalled();
    req.flush({
      generated_at: '1722060000',
      suggestions: [
        { subject: '家庭旅行计划.md', kind: 'summarize', filter: 'text' },
      ],
    });

    await expect(promise).resolves.toEqual({
      generated_at: '1722060000',
      suggestions: [
        { subject: '家庭旅行计划.md', kind: 'summarize', filter: 'text' },
      ],
    });
  });

  it('posts questions to the same-origin Harbor Assistant search endpoint', async () => {
    const promise = firstValueFrom(spectator.service.search({
      query: '找到和春天相关的照片',
      limit: 24,
      include_documents: true,
      include_audio: true,
      include_images: true,
      include_videos: true,
    }));

    const req = httpMock.expectOne('/api/harbor-gate/api/beacon/knowledge/search');
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('X-HarborOS-Auth-Token')).toBe('harbor-user-token');
    expect(req.request.body).toEqual({
      query: '找到和春天相关的照片',
      limit: 24,
      include_documents: true,
      include_audio: true,
      include_images: true,
      include_videos: true,
    });
    expect(req.request.url).not.toContain(':4174');
    req.flush({
      kind: 'rag.answer',
      query: '找到和春天相关的照片',
      answer: '照片中有春天的花朵。[1]',
      citations: [{ title: 'neutral-001.jpg' }],
      status: 'completed',
      degraded: false,
      warnings: [],
      query_understanding: { intent: 'search', needs_retrieval: true },
      search: {
        query: '找到和春天相关的照片',
        roots: [],
        total_matches: 1,
        documents: [],
        images: [{
          modality: 'image',
          path: '/mnt/software/photos/neutral-001.jpg',
          title: 'neutral-001.jpg',
          score: 88,
          content_source_kinds: ['vlm'],
          content_indexed: true,
          filename_match_used: false,
          content_match_used: true,
        }],
        videos: [],
        reply_pack: { summary: '', citations: [] },
        supported_modalities: ['document', 'image', 'video'],
        pending_modalities: [],
        status: 'ok',
        degraded: false,
        blockers: [],
        warnings: [],
        source_scope: [],
        privacy_level: 'strict_local',
        resource_profile: 'cpu_only',
      },
    });

    const response = await promise;
    expect(response.images[0].content_source_kinds).toEqual(['vlm']);
    expect(response.images[0].filename_match_used).toBe(false);
    expect(response.images[0].content_match_used).toBe(true);
    expect(response.answer).toBe('照片中有春天的花朵。[1]');
    expect(response.answer_intent).toBe('search');
    expect(spectator.inject(AuthService).getHarborAssistantOneTimeToken).toHaveBeenCalledTimes(1);
  });

  it('passes through a legacy flat response without retrying the POST', async () => {
    const legacyResponse = searchResponse({ answer: 'Legacy answer' });
    const promise = firstValueFrom(spectator.service.search(searchRequest('legacy')));

    const requests = httpMock.match('/api/harbor-gate/api/beacon/knowledge/search');
    expect(requests).toHaveLength(1);
    requests[0].flush(legacyResponse);

    await expect(promise).resolves.toBe(legacyResponse);
    expect(spectator.inject(AuthService).getHarborAssistantOneTimeToken).toHaveBeenCalledTimes(1);
  });

  it('normalizes a rag.answer envelope with envelope fields taking precedence', async () => {
    const promise = firstValueFrom(spectator.service.search({
      ...searchRequest('new response'),
      conversation_id: 'requested-conversation',
    }));
    const req = httpMock.expectOne('/api/harbor-gate/api/beacon/knowledge/search');
    req.flush({
      kind: 'rag.answer',
      conversation_id: 'server-conversation',
      query: 'new response',
      answer: 'Grounded answer',
      citations: [{ path: '/indexed/a.md' }],
      status: 'completed',
      degraded: true,
      degraded_reason: 'citation_validation_failed',
      review_scope: { returned_count: 5, reviewed_count: 3, max_reviewed_count: 3 },
      warnings: ['envelope warning', 'shared warning'],
      query_understanding: { intent: 'search', needs_retrieval: true },
      search: searchResponse({
        status: 'partial',
        degraded: false,
        degraded_reason: 'search reason',
        warnings: ['search warning', 'shared warning'],
        review_scope: { returned_count: 5, reviewed_count: 2, max_reviewed_count: 2 },
      }),
    });

    await expect(promise).resolves.toEqual(expect.objectContaining({
      conversation_id: 'server-conversation',
      status: 'partial',
      answer: 'Grounded answer',
      degraded: true,
      degraded_reason: 'citation_validation_failed',
      answer_degraded: true,
      answer_degraded_reason: 'citation_validation_failed',
      answer_intent: 'search',
      review_scope: { returned_count: 5, reviewed_count: 3, max_reviewed_count: 3 },
      reply_pack: {
        summary: 'Grounded answer',
        citations: [{ path: '/indexed/a.md' }],
      },
      warnings: ['search warning', 'shared warning', 'envelope warning'],
    }));
  });

  it('fails once for an unsupported response without probing or retrying', async () => {
    const promise = firstValueFrom(spectator.service.search(searchRequest('invalid')));
    const requests = httpMock.match('/api/harbor-gate/api/beacon/knowledge/search');
    expect(requests).toHaveLength(1);
    requests[0].flush({ kind: 'unexpected' });

    await expect(promise).rejects.toThrow('Harbor Assistant returned an unsupported search response.');
    httpMock.expectNone('/api/harbor-beacon/knowledge/search');
    expect(spectator.inject(AuthService).getHarborAssistantOneTimeToken).toHaveBeenCalledTimes(1);
  });

  it('builds encoded same-origin preview URLs', () => {
    const url = spectator.service.previewUrl(
      '/mnt/software/photos/春天 01.jpg',
    );

    expect(url).toBe(
      '/api/harbor-beacon/knowledge/preview?path=%2Fmnt%2Fsoftware%2Fphotos%2F%E6%98%A5%E5%A4%A9%2001.jpg',
    );
    expect(url).not.toContain(':4174');
    expect(url).not.toContain(':8787');
  });

  it('loads, deletes, and configures persistent conversation history', async () => {
    const listPromise = firstValueFrom(spectator.service.conversations());
    const listRequest = httpMock.expectOne('/api/harbor-gate/api/beacon/knowledge/conversations');
    expect(listRequest.request.headers.get('X-HarborOS-Auth-Token')).toBe('harbor-user-token');
    listRequest.flush({
      conversations: [{ conversation_id: 'conv-1', title: '春天的文章', turn_count: 2 }],
      settings: { history_limit: 10, context_turn_limit: 3, context_token_limit: 8192 },
    });
    expect((await listPromise).settings?.context_turn_limit).toBe(3);

    const detailPromise = firstValueFrom(spectator.service.conversation('conv-1'));
    const detailRequest = httpMock.expectOne('/api/harbor-gate/api/beacon/knowledge/conversations/conv-1');
    expect(detailRequest.request.method).toBe('GET');
    detailRequest.flush({ conversation_id: 'conv-1', turns: [] });
    expect((await detailPromise).conversation_id).toBe('conv-1');

    const savePromise = firstValueFrom(spectator.service.saveConversationSettings({
      history_limit: 20,
      context_turn_limit: 5,
      context_token_limit: 8192,
    }));
    const saveRequest = httpMock.expectOne('/api/harbor-gate/api/beacon/knowledge/conversation-settings');
    expect(saveRequest.request.method).toBe('PATCH');
    expect(saveRequest.request.body).toEqual({
      history_limit: 20,
      context_turn_limit: 5,
      context_token_limit: 8192,
    });
    saveRequest.flush({ history_limit: 20, context_turn_limit: 5, context_token_limit: 8192 });
    expect((await savePromise).history_limit).toBe(20);

    const deletePromise = firstValueFrom(spectator.service.deleteConversation('conv-1'));
    const deleteRequest = httpMock.expectOne('/api/harbor-gate/api/beacon/knowledge/conversations/conv-1');
    expect(deleteRequest.request.method).toBe('DELETE');
    deleteRequest.flush({ deleted: true, conversation_id: 'conv-1' });
    expect((await deletePromise).deleted).toBe(true);
    expect(spectator.inject(AuthService).getHarborAssistantOneTimeToken).toHaveBeenCalledTimes(4);
  });

  it('reads camera DVR state from same-origin Harbor Assistant endpoints', async () => {
    const statePromise = firstValueFrom(spectator.service.cameraState());
    httpMock.expectOne('/api/harbor-beacon/state').flush({
      defaults: { selected_camera_device_id: 'camera-main' },
      devices: [{ device_id: 'camera-main', name: 'Front Door' }],
    });
    expect((await statePromise).devices[0].device_id).toBe('camera-main');

    const statusPromise = firstValueFrom(spectator.service.dvrStatus());
    httpMock.expectOne('/api/harbor-beacon/cameras/recordings/status').flush({
      generated_at: '1',
      statuses: [{ device_id: 'camera-main', status: 'recording' }],
    });
    expect((await statusPromise).statuses[0].status).toBe('recording');

    const timelinePromise = firstValueFrom(
      spectator.service.dvrTimeline('camera-main'),
    );
    httpMock
      .expectOne(
        '/api/harbor-beacon/cameras/recordings/timeline?device_id=camera-main',
      )
      .flush({
        generated_at: '1',
        recording_root: '/recordings',
        segments: [
          {
            device_id: 'camera-main',
            file_path: '/recordings/camera-main.mp4',
          },
        ],
      });
    expect((await timelinePromise).segments[0].file_path).toContain(
      'camera-main',
    );

    const filteredTimelinePromise = firstValueFrom(
      spectator.service.dvrTimeline('camera-main', '1714600000', '1714600300'),
    );
    httpMock
      .expectOne(
        '/api/harbor-beacon/cameras/recordings/timeline?device_id=camera-main&from=1714600000&to=1714600300',
      )
      .flush({
        generated_at: '1',
        recording_root: '/recordings',
        segments: [],
      });
    expect((await filteredTimelinePromise).segments).toEqual([]);

    const startPromise = firstValueFrom(
      spectator.service.startDvrRecording('camera-main', 'main'),
    );
    const startReq = httpMock.expectOne(
      '/api/harbor-beacon/cameras/camera-main/recordings/start',
    );
    expect(startReq.request.method).toBe('POST');
    expect(startReq.request.body).toEqual({ stream_profile: 'main' });
    startReq.flush({
      generated_at: '2',
      statuses: [{ device_id: 'camera-main', status: 'recording' }],
    });
    expect((await startPromise).statuses[0].status).toBe('recording');

    const stopPromise = firstValueFrom(
      spectator.service.stopDvrRecording('camera-main'),
    );
    httpMock
      .expectOne('/api/harbor-beacon/cameras/camera-main/recordings/stop')
      .flush({
        generated_at: '3',
        statuses: [{ device_id: 'camera-main', status: 'stopped' }],
      });
    expect((await stopPromise).statuses[0].status).toBe('stopped');

    const livePromise = firstValueFrom(
      spectator.service.startCameraLiveSession('camera-main', 'main'),
    );
    const liveReq = httpMock.expectOne(
      '/api/harbor-beacon/cameras/camera-main/live/start',
    );
    expect(liveReq.request.method).toBe('POST');
    expect(liveReq.request.body).toEqual({ stream_profile: 'main' });
    const liveStartRequestId = liveReq.request.headers.get('X-Request-Id');
    expect(liveStartRequestId).toMatch(/^webui:live-start:camera-main:/);
    liveReq.flush({
      device_id: 'camera-main',
      session_id: 'live-main',
      status: 'running',
      playlist_ready: true,
      mode: 'hls_fmp4',
      codec: 'h264_low_latency',
      stream_profile: 'main',
      updated_at: '4',
    });
    expect((await livePromise).stream_profile).toBe('main');

    const renewPromise = firstValueFrom(
      spectator.service.renewCameraLiveSession('camera-main', 'live-main', 300),
    );
    const renewReq = httpMock.expectOne(
      '/api/harbor-beacon/cameras/camera-main/live/renew',
    );
    expect(renewReq.request.method).toBe('POST');
    expect(renewReq.request.body).toEqual({
      session_id: 'live-main',
      ttl_seconds: 300,
    });
    const liveRenewRequestId = renewReq.request.headers.get('X-Request-Id');
    expect(liveRenewRequestId).toMatch(/^webui:live-renew:camera-main:live-main:/);
    expect(liveRenewRequestId).not.toBe(liveStartRequestId);
    renewReq.flush({
      device_id: 'camera-main',
      session_id: 'live-main',
      status: 'running',
      playlist_ready: true,
      mode: 'harborlink_media',
      codec: 'h264',
      stream_profile: 'main',
      updated_at: '5',
    });
    expect((await renewPromise).session_id).toBe('live-main');

    const snapshotPromise = firstValueFrom(
      spectator.service.createSnapshotTask('camera-main'),
    );
    httpMock
      .expectOne('/api/harbor-beacon/cameras/camera-main/snapshot')
      .flush({ task_id: 'task-1' });
    expect(await snapshotPromise).toEqual({ task_id: 'task-1' });
    expect(spectator.inject(AuthService).getHarborAssistantOneTimeToken).not.toHaveBeenCalled();
  });

  it('keeps the business request ID stable when a mutation request is resubscribed', async () => {
    const stopRequest$ = spectator.service.stopCameraLiveSession('camera-main', 'live-main');
    const response = {
      device_id: 'camera-main',
      session_id: 'live-main',
      status: 'stopped',
      playlist_ready: false,
      mode: 'harborlink_media',
      codec: 'h264',
      stream_profile: 'main',
      updated_at: '6',
    };

    const firstPromise = firstValueFrom(stopRequest$);
    const firstRequest = httpMock.expectOne('/api/harbor-beacon/cameras/camera-main/live/stop');
    const firstRequestId = firstRequest.request.headers.get('X-Request-Id');
    firstRequest.flush(response);
    await firstPromise;

    const secondPromise = firstValueFrom(stopRequest$);
    const secondRequest = httpMock.expectOne('/api/harbor-beacon/cameras/camera-main/live/stop');
    expect(secondRequest.request.headers.get('X-Request-Id')).toBe(firstRequestId);
    secondRequest.flush(response);
    await secondPromise;
  });

  it('uses same-origin Harbor Assistant proxy paths and avoids direct service ports', () => {
    const sources = [
      'src/app/pages/harbor-assistant/shared/harbor-assistant-content-api.service.ts',
      'src/app/pages/harbor-assistant/shared/harbor-assistant-results.ts',
      'src/app/pages/harbor-assistant/search/harbor-assistant-search.component.ts',
      'src/app/pages/harbor-assistant/camera/harbor-assistant-camera.component.ts',
    ]
      .map((path) => readFileSync(join(process.cwd(), path), 'utf8'))
      .join('\n');

    expect(sources).toContain('harborAssistantBeaconApiUrl');
    expect(sources).toContain("this.gateApiUrl('/knowledge/search')");
    expect(sources).not.toContain("this.apiUrl('/knowledge/answer')");
    expect(sources).toContain('harborAssistantBeaconApiUrl(`/knowledge/preview');
    expect(sources).toContain("this.apiUrl('/cameras/recordings/status')");
    expect(sources).toContain(
      ['this.apiUrl(`/cameras/$', '{encodeURIComponent(deviceId)}/recordings/start`)'].join(''),
    );
    expect(sources).toContain(
      ['this.apiUrl(`/cameras/$', '{encodeURIComponent(deviceId)}/snapshot`)'].join(''),
    );
    expect(sources).not.toContain('/api/harbor-assistant');
    [
      ':4174',
      ':4175',
      ':4176',
      ':4196',
      ':8787',
      '/api/turns',
      '/api/web/turns',
    ].forEach((forbidden) => {
      expect(sources).not.toContain(forbidden);
    });
  });

  it('keeps the HarborNavi build on its direct Beacon path without HarborOS token generation', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.harbornavi.ts'),
      'utf8',
    );

    expect(source).toContain(['return `/api/beacon$', '{path}`'].join(''));
    expect(source).toContain('harborAssistantGateRequiresUserToken');
    expect(source).toContain('return false;');
  });
});

function searchRequest(query: string): HarborAssistantSearchRequest {
  return {
    query,
    include_documents: true,
    include_audio: true,
    include_images: true,
    include_videos: true,
  };
}

function searchResponse(partial: Partial<HarborAssistantSearchResponse> = {}): HarborAssistantSearchResponse {
  return {
    query: partial.query ?? 'query',
    roots: [],
    total_matches: partial.total_matches ?? 0,
    documents: partial.documents ?? [],
    images: partial.images ?? [],
    videos: partial.videos ?? [],
    reply_pack: partial.reply_pack ?? { summary: '', citations: [] },
    supported_modalities: ['document', 'image', 'video'],
    pending_modalities: [],
    status: partial.status ?? 'ok',
    degraded: partial.degraded ?? false,
    degraded_reason: partial.degraded_reason,
    blockers: partial.blockers ?? [],
    warnings: partial.warnings ?? [],
    source_scope: [],
    privacy_level: 'strict_local',
    resource_profile: 'cpu_only',
    answer: partial.answer,
    review_scope: partial.review_scope,
  };
}
