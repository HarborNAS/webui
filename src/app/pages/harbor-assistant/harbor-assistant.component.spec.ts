import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discardPeriodicTasks, fakeAsync, tick } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { convertToParamMap, ActivatedRoute, Router } from '@angular/router';
import { createComponentFactory, mockProvider, Spectator } from '@ngneat/spectator/jest';
import { MockComponent } from 'ng-mocks';
import { of, Subject, throwError } from 'rxjs';
import { PageHeaderComponent } from 'app/modules/page-header/page-title-header/page-header.component';
import { AssistantSessionStore } from 'app/pages/harbor-assistant/composer/assistant-session.store';
import { HarborAssistantComponent } from 'app/pages/harbor-assistant/harbor-assistant.component';
import { HarborAssistantApiService } from 'app/pages/harbor-assistant/services/harbor-assistant-api.service';
import { HarborAssistantContentApiService } from 'app/pages/harbor-assistant/shared/harbor-assistant-content-api.service';

describe('Harbor Assistant component', () => {
  let spectator: Spectator<HarborAssistantComponent>;
  let api: Partial<Record<keyof HarborAssistantApiService, jest.Mock>>;
  let matDialog: { open: jest.Mock };
  const router = {
    events: of(),
    navigate: jest.fn(),
    createUrlTree: jest.fn(() => ({})),
    serializeUrl: jest.fn(() => '/'),
  };

  const createComponent = createComponentFactory({
    component: HarborAssistantComponent,
    imports: [
      MockComponent(PageHeaderComponent),
    ],
    providers: [
      {
        provide: HarborAssistantApiService,
        useFactory: (): Partial<Record<keyof HarborAssistantApiService, jest.Mock>> => api,
      },
      mockProvider(ActivatedRoute, {
        queryParamMap: of(convertToParamMap({ tab: 'settings', section: 'ai' })),
      }),
      mockProvider(MatDialog, {
        open: jest.fn(() => ({
          afterClosed: () => of({ path: '/mnt/pool/videos' }),
        })),
      }),
      mockProvider(Router, router),
    ],
  });

  beforeEach(() => {
    router.navigate.mockClear();
    api = harborAssistantApiMock();
    matDialog = {
      open: jest.fn(() => ({
        afterClosed: () => of({ path: '/mnt/pool/videos' }),
      })),
    };
  });

  it('renders flat settings navigation with Models first and no duplicate tools', () => {
    spectator = createComponent();
    spectator.detectChanges();

    expect(spectator.query('.harbor-assistant-page')).toExist();
    expect(spectator.query('.harbor-assistant-intro')).not.toExist();
    expect(spectator.query('.ai-settings-card')).toExist();
    expect(spectator.query('.ai-status-toolbar')).not.toExist();
    expect(spectator.query('.settings-section-strip')).toHaveText('Models');
    expect(spectator.query('.settings-section-strip')).toHaveText('Data sources');
    expect(spectator.query('.settings-section-strip')).toHaveText('Connections');
    expect(spectator.query('.settings-section-strip')).toHaveText('Camera settings');
    expect(spectator.query('.settings-section-strip')).toHaveText('Diagnostics');
    expect(spectator.query('.ai-settings-subtabs')).not.toExist();
    expect(spectator.query('.workflow-stepper')).not.toExist();
    expect(spectator.query('.model-library-card')).not.toExist();
    expect(spectator.element.textContent).not.toContain('Harbor AI Settings');
    expect(spectator.element.textContent).not.toContain('Harbor Assistant Search / Harbor Assistant Camera');
    expect(spectator.element.textContent).not.toContain('Local capabilities and model recommendations');
    expect(spectator.element.textContent).not.toContain('System diagnostics');
    expect(spectator.query('.integrated-multimodal-panel')).not.toExist();
    expect(spectator.element.textContent?.toLowerCase()).not.toContain('fallback order');
  });

  it.each([
    [{ tab: 'settings' }, 'models'],
    [{ tab: 'models' }, 'models'],
    [{ tab: 'settings', section: 'models' }, 'models'],
    [{ tab: 'settings', section: 'sources' }, 'sources'],
    [{ tab: 'settings', section: 'connections' }, 'connections'],
    [{ tab: 'messages' }, 'connections'],
    [{ tab: 'settings', section: 'camera' }, 'camera'],
    [{ tab: 'settings', section: 'diagnostics' }, 'diagnostics'],
    [{ tab: 'settings', section: 'ai', focus: 'sources' }, 'sources'],
  ])('restores the flat settings destination from %o', (params, destination) => {
    spectator = createComponent({
      providers: [mockProvider(ActivatedRoute, { queryParamMap: of(convertToParamMap(params)) })],
    });
    expect(spectator.query(`[data-settings-section="${destination}"]`)).toHaveAttribute('aria-current', 'page');
    expect(spectator.query('[data-section="settings"]')).toHaveAttribute('aria-current', 'page');
    expect(spectator.query('.workspace-navigation [data-section="models"]')).not.toExist();
    expect(spectator.query('.workspace-navigation [data-section="sources"]')).not.toExist();
    expect(spectator.query('.workspace-navigation [data-section="messages"]')).not.toExist();
    expect(spectator.query('.ai-settings-subtabs')).not.toExist();
    expect(api.saveModelPolicies).not.toHaveBeenCalled();
    expect(api.createModelEndpoint).not.toHaveBeenCalled();
  });

  it('shows pinned media models and existing choices without rendering model test forms', () => {
    configurePinnedMediaModels();
    spectator = createComponent();
    expect(spectator.query('[data-capability="asr"]')).toHaveText('Whisper 780M');
    expect(spectator.query('[data-capability="asr"]')).toHaveText('Radeon 780M');
    expect(spectator.query('[data-capability="tts"]')).toHaveText('Piper bilingual');
    expect(spectator.query('[data-capability="vlm"]')).toHaveText('Qwen3.8 27B');
    expect(spectator.query('[data-capability="photo_verification_careful"]')).toHaveText('Qwen2.5 VL 7B');
    expect(spectator.query('.model-capability-list form')).not.toExist();
    expect(spectator.query('ix-harbor-assistant-multimodal')).not.toExist();
    expect(spectator.query('.integrated-multimodal-panel')).not.toExist();
    expect(spectator.queryAll('.model-capability-list button').map((button) => button.textContent?.trim()))
      .not.toContain('Test');
    expect(spectator.query('[data-capability="tts"]')).not.toHaveText('More models');
    spectator.click('[data-capability="photo_verification_careful"] .row-actions button');
    expect(spectator.query('[data-capability="photo_verification_careful"] .inline-model-panel'))
      .toHaveText('Qwen2.5 VL 7B');
    expect(spectator.query('[data-capability="photo_verification_careful"] .inline-model-panel'))
      .toHaveText('Qwen3.8 27B');
    const component = spectator.component as unknown as { workflowCurrentModelMetadata: (kind: string) => string };
    expect(component.workflowCurrentModelMetadata('asr')).toContain('11443');
    expect(spectator.query('[data-capability="asr"] .model-current-cell')).not.toHaveText('127.0.0.1');
    expect(api.saveModelPolicies).not.toHaveBeenCalled();
    expect(api.updateModelEndpoint).not.toHaveBeenCalled();
    expect(api.testModelEndpoint).not.toHaveBeenCalled();
  });

  it('distinguishes configured ASR choices by their reported device when model names are identical', () => {
    configurePinnedMediaModels();
    api.getModelEndpoints = jest.fn(() => of({
      endpoints: [
        {
          ...modelEndpoint('asr-cpu', 'asr', 'whisper-small-multilingual') as object,
          metadata: { runtime_device: 'CPU' },
        },
        {
          ...modelEndpoint('asr-780m', 'asr', 'whisper-small-multilingual') as object,
          metadata: { runtime_device: 'Radeon 780M' },
        },
      ],
    }));
    spectator = createComponent();
    spectator.click('[data-capability="asr"] .row-actions button');
    const choices = spectator.query('[data-capability="asr"] .inline-model-panel');
    expect(choices).toHaveText('whisper-small-multilingual');
    expect(choices).toHaveText('CPU');
    expect(choices).toHaveText('Radeon 780M');
    expect(choices).not.toHaveText('asr-cpu');
    expect(choices).not.toHaveText('asr-780m');
    expect(api.saveModelPolicies).not.toHaveBeenCalled();
    expect(api.updateModelEndpoint).not.toHaveBeenCalled();
  });

  it('keeps a stale desired bootstrap binding selectable while the confirmed runtime is 27B', () => {
    api.getModelCapabilities = jest.fn(() => of(routerSelectionCapabilities({
      desired_model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
      selected_model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
      active_model_id: 'harbor-qwen38-27b',
      transition_status: 'ready',
      current_model: {
        model_endpoint_id: 'llm-local-qwen38-27b',
        model_name: 'harbor-qwen38-27b',
        provider_key: 'local',
        status: 'active',
      },
    })));
    api.getModelEndpoints = jest.fn(() => of({
      endpoints: [{
        ...modelEndpoint('llm-local-openai-compatible', 'llm', '/models/bootstrap-llm') as object,
        metadata: { catalog_model_id: 'Qwen/Qwen2.5-0.5B-Instruct' },
      }, modelEndpoint('llm-local-qwen38-27b', 'llm', 'Qwen3.8-27B-Q8_0')],
    }));
    api.getModelPolicies = jest.fn(() => of({
      route_policies: [{
        ...modelPolicy('semantic.router', 'strict_local', ['local']) as object,
        metadata: { model_endpoint_id: 'llm-local-qwen38-27b' },
      }],
    }));
    spectator = createComponent();
    spectator.click('[data-capability="semantic_router"] .row-actions button');
    const options = spectator.queryAll('[data-capability="semantic_router"] .model-option-row');
    const small = options.find((row) => row.querySelector('strong')?.textContent?.includes('/models/bootstrap-llm'));
    const large = options.find((row) => row.querySelector('strong')?.textContent?.includes('Qwen3.8-27B-Q8_0'));
    expect(small?.querySelector('button')).toHaveText('Select');
    expect(small?.querySelector('button')).not.toBeDisabled();
    expect(large?.querySelector('button')).toHaveText('Selected');
    expect(large?.querySelector('button')).toBeDisabled();
    expect(spectator.query('[data-capability="semantic_router"] .model-current-cell strong'))
      .toHaveText('Qwen3.8 27B');
  });

  it('never replays a historical completed download selection on page load, refresh or polling', fakeAsync(() => {
    const job = {
      job_id: 'historical-qwen4b',
      model_id: 'Qwen/Qwen3.5-4B',
      status: 'completed',
      target_path: '/models/qwen4b',
      metadata: {
        auto_select_after_download: true,
        auto_select_capability_id: 'semantic_router',
        auto_select_model_id: 'Qwen/Qwen3.5-4B',
      },
    };
    api.getModelCapabilities = jest.fn(() => of(routerSelectionCapabilities()));
    api.getLocalModelCatalog = jest.fn(() => of({
      models: [qwenCatalogModel({
        model_kind: 'llm',
        installed: true,
        status: 'ready',
        local_path: '/models/qwen4b',
        expected_capabilities: ['semantic_router'],
      })],
      download_jobs: [job],
    }));
    api.getLocalModelDownloads = jest.fn(() => of({ jobs: [job] }));
    api.selectModelCapability = jest.fn(() => of(routerSelectionCapabilities()));
    spectator = createComponent();
    spectator.detectChanges();
    expect(api.selectModelCapability).not.toHaveBeenCalled();
    const component = spectator.component as unknown as { refresh: () => void };
    component.refresh();
    tick(5000);
    spectator.fixture.nativeElement.ownerDocument.defaultView.dispatchEvent(new Event('focus'));
    expect(api.selectModelCapability).not.toHaveBeenCalled();
    expect(api.updateModelEndpoint).not.toHaveBeenCalled();
    expect(api.saveModelPolicies).not.toHaveBeenCalled();
    spectator.fixture.destroy();
    discardPeriodicTasks();
  }));

  it('marks only the desired runtime binding selected when ASR models share an identity', () => {
    configurePinnedMediaModels();
    api.getModelCapabilities = jest.fn(() => of({
      capabilities: [{
        capability_id: 'asr',
        model_kind: 'asr',
        status: 'ready',
        desired_model_id: 'asr-780m',
        active_model_id: 'whisper-small-multilingual',
        transition_status: 'ready',
        current_model: { model_endpoint_id: 'asr-780m', model_name: 'whisper-small-multilingual', status: 'active' },
      }],
    }));
    spectator = createComponent();
    spectator.click('[data-capability="asr"] .row-actions button');
    const options = spectator.queryAll('[data-capability="asr"] .model-option-row');
    const cpu = options.find((row) => row.textContent?.includes('Whisper CPU'));
    const igpu = options.find((row) => row.textContent?.includes('Whisper 780M'));
    expect(cpu?.querySelector('button')).toHaveText('Select');
    expect(cpu?.querySelector('button')).not.toBeDisabled();
    expect(igpu?.querySelector('button')).toHaveText('Selected');
    expect(igpu?.querySelector('button')).toBeDisabled();
  });

  it('selects an existing photo runtime through the shared capability selection API', () => {
    configurePinnedMediaModels();
    api.selectModelCapability = jest.fn(() => of({ capabilities: [] }));
    spectator = createComponent();
    spectator.click('[data-capability="photo_verification_careful"] .row-actions button');
    const option = spectator.queryAll('[data-capability="photo_verification_careful"] .model-option-row')
      .find((row) => row.textContent?.includes('Qwen3.8 27B'));
    spectator.click(option?.querySelector('button') as HTMLButtonElement);
    expect(api.selectModelCapability).toHaveBeenCalledWith('photo_verification_careful', 'vision-27b', 'vision-27b');
    expect(api.saveModelPolicies).not.toHaveBeenCalled();
    expect(api.updateModelEndpoint).not.toHaveBeenCalled();
    expect(api.createModelEndpoint).not.toHaveBeenCalled();
  });

  it('does not replace an unavailable explicit ASR pin with the first active CPU endpoint', () => {
    configurePinnedMediaModels('disabled');
    spectator = createComponent();
    expect(spectator.query('[data-capability="asr"]')).toHaveText('Model status unavailable');
    expect(spectator.query('[data-capability="asr"]')).toHaveText('Unavailable');
    expect(spectator.query('[data-capability="asr"]')).not.toHaveText('Whisper CPU');
  });

  it('shows the actual degraded pinned model status without claiming it is Ready', () => {
    configurePinnedMediaModels('degraded');
    spectator = createComponent();
    expect(spectator.query('[data-capability="asr"]')).toHaveText('Whisper 780M');
    expect(spectator.query('[data-capability="asr"]')).toHaveText('Needs check');
    expect(spectator.query('[data-capability="asr"] .pill')).not.toHaveText('Ready');
    expect(spectator.query('[data-capability="photo_verification_careful"]'))
      .not.toHaveText('Choose an installed model below');
  });

  function configurePinnedMediaModels(asrStatus = 'active'): {
    route_policy_id: string; metadata: Record<string, unknown>;
  }[] {
    const mediaEndpoint = (id: string, kind: string, name: string, port: number, device: string): object => ({
      ...modelEndpoint(id, kind, name) as object,
      metadata: { base_url: `http://127.0.0.1:${port}`, runtime_device: device },
    });
    const mediaPolicy = (id: string, metadata: Record<string, string>): {
      route_policy_id: string; metadata: Record<string, string>;
    } => ({ ...modelPolicy(id, 'strict_local', ['local']) as { route_policy_id: string }, metadata });
    const endpoints = [
      mediaEndpoint('asr-cpu', 'asr', 'Whisper CPU', 11438, 'CPU'),
      { ...mediaEndpoint('asr-780m', 'asr', 'Whisper 780M', 11443, 'Radeon 780M'), status: asrStatus },
      mediaEndpoint('vision-7b', 'vlm', 'Qwen2.5 VL 7B', 11444, 'W7900'),
      mediaEndpoint('vision-27b', 'vlm', 'Qwen3.8 27B', 11442, 'W7900'),
      mediaEndpoint('tts-local', 'tts', 'Piper bilingual', 11439, 'CPU'),
    ];
    const policies = [
      mediaPolicy('retrieval.vision_summary', { model_endpoint_id: 'vision-27b' }),
      mediaPolicy('photo_verification_careful', {
        model_endpoint_id: 'vision-7b', fallback_endpoint_id: 'vision-27b',
      }),
      mediaPolicy('retrieval.asr', { model_endpoint_id: 'asr-780m' }),
      mediaPolicy('assistant.tts', { model_endpoint_id: 'tts-local' }),
    ];
    api.selectModelCapability = jest.fn();
    api.getModelEndpoints = jest.fn(() => of({ endpoints }));
    api.getModelCapabilities = jest.fn(() => of({ capabilities: [], blockers: [], warnings: [] }));
    api.getModelPolicies = jest.fn(() => of({ route_policies: policies }));
    return policies;
  }

  it.each(['active', 'degraded'])('uses actual %s media endpoint status for managed runtime guidance', (status) => {
    configurePinnedMediaModels(status);
    const notice = 'Managed runtime unavailable; connect an external endpoint.';
    api.getModelCapabilities = jest.fn(() => of({
      capabilities: ['asr', 'vlm'].map((kind) => ({
        capability_id: kind,
        model_kind: kind,
        status: kind === 'asr' && status === 'degraded' ? 'degraded' : 'ready',
        required_runtime_profile: 'managed-media-runtime',
        runtime_installed: false,
        runtime_next_action: notice,
        installed_models: [],
        installable_models: [],
        download_jobs: [],
      })),
    }));
    api.getModelRuntimes = jest.fn(() => of({
      runtimes: [{
        runtime_id: 'managed-media-runtime', installable: true, installed: false, active: false,
      }],
    }));
    spectator = createComponent();
    const component = spectator.component as unknown as {
      workflowRuntimeNotice: (kind: string) => string | null;
      workflowRuntimeInstallCandidate: (kind: string) => unknown;
    };
    expect(component.workflowRuntimeNotice('vlm')).toBeNull();
    expect(component.workflowRuntimeInstallCandidate('vlm')).toBeNull();
    if (status === 'active') {
      expect(component.workflowRuntimeNotice('asr')).toBeNull();
      expect(component.workflowRuntimeInstallCandidate('asr')).toBeNull();
      expect(spectator.query('[data-capability="asr"]')).not.toHaveText(notice);
    } else {
      expect(component.workflowRuntimeNotice('asr')).toBe(notice);
      expect(component.workflowRuntimeInstallCandidate('asr')).toBeTruthy();
      expect(spectator.query('[data-capability="asr"]')).toHaveText(notice);
    }
    expect(api.installModelRuntime).not.toHaveBeenCalled();
  });

  it.each([false, true])('hides the embedding model storage path (catalog=%s)', (catalogKnown) => {
    const localPath = '/var/lib/harborbeacon-agent-ci/models/jina-embeddings-v2-base-zh';
    api.getModelCapabilities = jest.fn(() => of(modelCapabilitiesWithEmbedder({
      status: 'ready',
      current_model: {
        model_endpoint_id: 'embedder-local', model_name: localPath, provider_key: 'local', status: 'active',
      },
    })));
    if (catalogKnown) {
      api.getLocalModelCatalog = jest.fn(() => of({
        models: [{
          model_id: 'jina-zh', display_name: 'Jina Chinese embeddings', local_path: localPath,
          model_kind: 'embedder', installed: true, status: 'installed',
        }],
        download_jobs: [],
      }));
    }
    spectator = createComponent();
    const cell = spectator.query('[data-capability="embedder"] .model-current-cell');
    expect(cell).toHaveText(catalogKnown ? 'Jina Chinese embeddings' : 'jina-embeddings-v2-base-zh');
    expect(cell).not.toHaveText('/var/lib/');
    expect(api.saveModelPolicies).not.toHaveBeenCalled();
    expect(api.updateModelEndpoint).not.toHaveBeenCalled();
  });

  it('shows a loading state instead of empty model readiness while projections are pending', () => {
    spectator = createComponent();
    const component = spectator.component as unknown as {
      loading: { set: (value: boolean) => void };
      modelEndpointsResponse: { set: (value: unknown) => void };
      modelCapabilitiesResponse: { set: (value: unknown) => void };
      modelRuntimeManagerResponse: { set: (value: unknown) => void };
      activeAiSettingsTab: { set: (value: string) => void };
    };
    component.loading.set(true);
    component.activeAiSettingsTab.set('models');
    component.modelEndpointsResponse.set(null);
    component.modelCapabilitiesResponse.set(null);
    component.modelRuntimeManagerResponse.set(null);
    spectator.detectChanges();

    expect(spectator.query('[data-testid="model-projection-loading"]')).toExist();
    expect(spectator.element.textContent).toContain('Loading runtime and model status');
    expect(spectator.element.textContent).not.toContain('0/4 Ready');
  });

  it('renders external llama.cpp endpoint metadata after model projections load', () => {
    spectator = createComponent();
    const component = spectator.component as unknown as {
      loading: { set: (value: boolean) => void };
      modelEndpointsResponse: { set: (value: unknown) => void };
      modelCapabilitiesResponse: { set: (value: unknown) => void };
      modelRuntimeManagerResponse: { set: (value: unknown) => void };
      workflowCurrentModelMetadata: (kind: string) => string;
    };
    component.loading.set(false);
    component.modelEndpointsResponse.set({
      endpoints: [{
        model_endpoint_id: 'llm-local-llama-vulkan-demo',
        model_kind: 'llm',
        endpoint_kind: 'local',
        provider_key: 'openai_compatible',
        model_name: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
        capability_tags: ['chat', 'llama.cpp'],
        status: 'active',
        metadata: {
          base_url: 'http://127.0.0.1:11435/v1',
          runtime_backend_kind: 'llama.cpp',
          runtime_device: 'Vulkan1: AMD Radeon Pro W7900 (RADV NAVI31)',
          persistent: true,
        },
      }],
    });
    component.modelCapabilitiesResponse.set({
      capabilities: [],
      runtime_manager: { status: 'ready', runtimes: [] },
      model_store: { status: 'ready', path: '/models' },
    });
    component.modelRuntimeManagerResponse.set({ status: 'ready', runtimes: [] });
    spectator.detectChanges();

    const metadata = component.workflowCurrentModelMetadata('llm');
    expect(metadata).toContain('llama.cpp');
    expect(metadata).toContain('Vulkan1: AMD Radeon Pro W7900');
    expect(metadata).toContain('http://127.0.0.1:11435/v1');
    expect(metadata).toContain('persistent');
  });

  it('refreshes only real model status after a completed search warms a cold embedder', () => {
    const warmedCapabilities$ = new Subject<unknown>();
    api.getModelCapabilities = jest.fn()
      .mockReturnValueOnce(of(modelCapabilitiesWithEmbedder({ status: 'needs_model', runtime_ready: false })))
      .mockReturnValue(warmedCapabilities$);
    const coldRag = { status: 'degraded', embedding_model: { status: 'needs_model' } };
    const warmRag = { status: 'ready', embedding_model: { status: 'ready' } };
    api.getRagReadiness = jest.fn().mockReturnValueOnce(of(coldRag)).mockReturnValue(of(warmRag));
    const content = {
      search: jest.fn(() => of({ reply_pack: { summary: 'A cited answer', citations: [] }, blockers: [], warnings: [] })),
      conversations: jest.fn(() => of({ conversations: [] })),
    };
    spectator = createComponent({ providers: [{ provide: HarborAssistantContentApiService, useValue: content }] });
    const session = spectator.inject(AssistantSessionStore);
    session.bindUser('cold-embedder-test');
    expect(spectator.query('[data-capability="embedder"]')).not.toHaveText('Available');
    const previousSettingsCalls = api.getKnowledgeSettings?.mock.calls.length;
    session.updateDraft({ text: 'Read the indexed guide', retrievalMode: 'on' });
    session.send();
    spectator.detectChanges();
    expect(spectator.query('[data-testid="model-projection-loading"]')).toExist();
    expect(spectator.query('.ai-settings-subtabs')).not.toExist();
    warmedCapabilities$.next(modelCapabilitiesWithEmbedder({ status: 'ready', runtime_ready: true }));
    warmedCapabilities$.complete();
    spectator.detectChanges();
    expect(spectator.query('[data-capability="embedder"]')).toHaveText('Available');
    expect(spectator.query('.ai-status-toolbar')).not.toExist();
    expect(api.getState).toHaveBeenCalledTimes(1);
    expect(api.getKnowledgeIndexStatus).toHaveBeenCalledTimes(1);
    expect(api.getKnowledgeSettings).toHaveBeenCalledTimes(previousSettingsCalls ?? 0);
    for (const name of ['getModelCapabilities', 'getModelRuntimes', 'getModelEndpoints',
      'getInferenceHealth', 'getLocalModelDownloads', 'getRagReadiness'] as const) {
      expect(api[name]).toHaveBeenCalledTimes(2);
    }
    expect(api.createModelEndpoint).not.toHaveBeenCalled();
    expect(api.updateModelEndpoint).not.toHaveBeenCalled();
    expect(api.installModelRuntime).not.toHaveBeenCalled();
  });

  it('does not let an older full-page or deferred snapshot overwrite readiness refreshed after a search', () => {
    const oldBootstrap$ = new Subject<unknown>();
    api.getGatewayStatus = jest.fn(() => oldBootstrap$);
    api.getModelCapabilities = jest.fn()
      .mockReturnValueOnce(of(modelCapabilitiesWithEmbedder({ status: 'needs_model', runtime_ready: false })))
      .mockReturnValue(of(modelCapabilitiesWithEmbedder({ status: 'ready', runtime_ready: true })));
    api.getRagReadiness = jest.fn()
      .mockReturnValueOnce(of({ status: 'ready', embedding_model: { status: 'ready' } }))
      .mockReturnValue(of({ status: 'degraded', embedding_model: { status: 'needs_model' } }));
    const content = {
      search: jest.fn(() => of({ reply_pack: { summary: 'A real answer', citations: [] }, blockers: [], warnings: [] })),
      conversations: jest.fn(() => of({ conversations: [] })),
    };
    spectator = createComponent({ providers: [{ provide: HarborAssistantContentApiService, useValue: content }] });
    const session = spectator.inject(AssistantSessionStore);
    session.bindUser('late-bootstrap-test');
    session.updateDraft({ text: 'Warm the index', retrievalMode: 'on' });
    session.send();
    spectator.detectChanges();
    const component = spectator.component as unknown as {
      modelCapabilitiesResponse: () => { capabilities: { capability_id: string; status: string }[] };
      rag: () => { embedding_model: { status: string } };
    };
    expect(component.modelCapabilitiesResponse().capabilities.find((item) => item.capability_id === 'embedder')?.status)
      .toBe('ready');
    oldBootstrap$.next({ status: 'ready', channels: [] });
    oldBootstrap$.complete();
    spectator.detectChanges();
    expect(component.modelCapabilitiesResponse().capabilities.find((item) => item.capability_id === 'embedder')?.status)
      .toBe('ready');
    expect(component.rag().embedding_model.status).toBe('ready');
    expect(spectator.query('[data-capability="embedder"]')).toHaveText('Available');
    expect(spectator.query('.ai-status-toolbar')).not.toExist();
    expect(api.getState).toHaveBeenCalledTimes(1);
  });

  it('does not show raw endpoint errors in the AI settings page', () => {
    spectator = createComponent();
    spectator.detectChanges();

    (spectator.component as unknown as { endpointErrors: { set: (errors: Record<string, string>) => void } })
      .endpointErrors
      .set({
        knowledgeIndexStatus: 'knowledge-index-status: Http failure response for /api/beacon/knowledge/index/status: 500 OK',
      });
    spectator.detectChanges();

    expect(spectator.element.textContent).toContain('Index status could not refresh');
    expect(spectator.element.textContent).not.toContain('Http failure');
    expect(spectator.element.textContent).not.toContain('500 OK');
  });

  it('defaults the Assistant entry to the workspace overview with one global composer', () => {
    spectator = createComponent({
      providers: [
        mockProvider(ActivatedRoute, {
          queryParamMap: of(convertToParamMap({})),
        }),
      ],
    });
    spectator.detectChanges();

    expect(spectator.query('.workspace-overview')).toExist();
    expect(spectator.query('ix-harbor-assistant-search')).not.toExist();
    expect(spectator.query('.settings-tab')).not.toExist();
  });

  it.each(['search', 'chat'])('maps the legacy %s link to overview without resetting the conversation', (tab) => {
    spectator = createComponent({
      detectChanges: false,
      providers: [mockProvider(ActivatedRoute, { queryParamMap: of(convertToParamMap({ tab })) })],
    });
    const session = spectator.inject(AssistantSessionStore);
    session.updateDraft({ text: 'Keep this draft', sourceRootIds: ['photos'] });
    const conversationId = session.conversationId();
    spectator.detectChanges();
    expect(spectator.query('.workspace-overview')).toExist();
    expect(spectator.query('ix-harbor-assistant-search')).not.toExist();
    expect(spectator.query('.assistant-chat-tab')).not.toExist();
    expect(session.draft().text).toBe('Keep this draft');
    expect(session.draft().sourceRootIds).toEqual(['photos']);
    expect(session.conversationId()).toBe(conversationId);
    expect(session.resultsOpen()).toBe(tab === 'chat');
  });

  it('opens data sources and model bookmarks from semantic management navigation', () => {
    spectator = createComponent({
      providers: [mockProvider(ActivatedRoute, { queryParamMap: of(convertToParamMap({})) })],
    });
    spectator.click('[data-section="settings"]');
    spectator.click('[data-settings-section="sources"]');
    expect(spectator.query('.sources-settings-panel')).toExist();
    expect(spectator.query('[data-settings-section="sources"]')).toHaveAttribute('aria-current', 'page');
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
      queryParams: {
        tab: 'settings', section: 'sources', focus: null, node: null,
      },
    }));
    spectator.click('[data-settings-section="models"]');
    expect(spectator.query('.model-capability-list')).toExist();
    expect(spectator.query('[data-settings-section="models"]')).toHaveAttribute('aria-current', 'page');
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
      queryParams: {
        tab: 'settings', section: 'models', focus: null, node: null,
      },
    }));
    spectator.click('[data-section="rules"]');
    expect(spectator.query('.rules-review-drawer')).toExist();
    expect(spectator.query('.settings-tab')).not.toExist();
    spectator.click('[data-section="overview"]');
    expect(spectator.query('.workspace-overview')).toExist();
    expect(spectator.query('.rules-review-drawer')).not.toExist();
  });

  it('shows pending readiness on overview while status projections are loading', () => {
    spectator = createComponent({
      providers: [mockProvider(ActivatedRoute, { queryParamMap: of(convertToParamMap({})) })],
    });
    const component = spectator.component as unknown as {
      loading: { set: (value: boolean) => void };
      knowledgeSettings: { set: (value: null) => void };
      knowledgeIndexStatus: { set: (value: null) => void };
      gatewayStatus: { set: (value: null) => void };
      modelEndpointsResponse: { set: (value: null) => void };
      modelCapabilitiesResponse: { set: (value: null) => void };
      modelRuntimeManagerResponse: { set: (value: null) => void };
    };
    component.loading.set(true);
    component.knowledgeSettings.set(null);
    component.knowledgeIndexStatus.set(null);
    component.gatewayStatus.set(null);
    component.modelEndpointsResponse.set(null);
    component.modelCapabilitiesResponse.set(null);
    component.modelRuntimeManagerResponse.set(null);
    spectator.detectChanges();
    expect(spectator.query('.workspace-readiness')).toHaveText('Loading data sources');
    expect(spectator.query('.workspace-readiness')).toHaveText('Loading model status');
    expect(spectator.query('.workspace-readiness')).toHaveText('Loading connections');
    expect(spectator.query('.workspace-readiness')).not.toHaveText('0/4 Ready');
    expect(spectator.query('ix-global-assistant-composer')).not.toExist();
  });

  it('normalizes a single-platform Feishu gateway projection into a connected card', () => {
    api.getGatewayStatus = jest.fn(() => of({
      status: 'connected', configured: true, connected: true,
    }));
    spectator = createComponent({
      providers: [mockProvider(ActivatedRoute, { queryParamMap: of(convertToParamMap({ tab: 'messages' })) })],
    });
    spectator.detectChanges();
    expect(spectator.query('.im-connector-list')).toHaveText('Feishu');
    expect(spectator.query('.im-connector-list')).toHaveText('Connected');
  });

  it('does not turn a Beacon bridge projection into a live connection count', () => {
    api.getGatewayStatus = jest.fn(() => of({
      status: 'ready', bridge_provider: { platform: 'feishu', configured: true, connected: false },
    }));
    spectator = createComponent({
      providers: [mockProvider(ActivatedRoute, { queryParamMap: of(convertToParamMap({})) })],
    });
    expect(spectator.query('.workspace-readiness')).toHaveText('Connection status unavailable');
    expect(spectator.query('.workspace-readiness')).not.toHaveText('0 connected');
    const component = spectator.component as unknown as {
      gatewayStatus: { set: (value: unknown) => void };
    };
    component.gatewayStatus.set({ channels: [{ platform: 'feishu', configured: true, connected: true }] });
    spectator.detectChanges();
    expect(spectator.query('.workspace-readiness')).toHaveText('1 connected');
  });

  it('redirects the legacy multimodal tab into Models settings while keeping model choices', () => {
    spectator = createComponent({
      providers: [mockProvider(ActivatedRoute, { queryParamMap: of(convertToParamMap({ tab: 'multimodal' })) })],
    });
    spectator.detectChanges();
    expect(spectator.query('.settings-tab')).toExist();
    expect(spectator.query('.integrated-multimodal-panel')).not.toExist();
    expect(spectator.query('[data-settings-section="models"]')).toHaveAttribute('aria-current', 'page');
    expect(spectator.query('.model-capability-list')).toExist();
    expect(spectator.query('.workspace-tools')).not.toHaveText('Multimodal');
  });

  it('uses workspace navigation for management and keeps existing secondary tools', () => {
    spectator = createComponent();
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      selectTab: (tab: 'messages' | 'home-assistant' | 'settings') => void;
      selectSettingsSection: (section: 'ai' | 'camera' | 'diagnostics') => void;
      targetRoutePreview: (target: { target_id: string; label: string; route_key: string }) => string;
    };

    expect(spectator.query('.workspace-navigation')).toHaveText('Overview');
    expect(spectator.query('.workspace-navigation')).not.toHaveText('Data sources');
    expect(spectator.query('.workspace-navigation')).not.toHaveText('Models');
    expect(spectator.query('.workspace-navigation')).not.toHaveText('Connections');
    expect(spectator.query('.workspace-navigation')).toHaveText('Rules');
    expect(spectator.query('.workspace-tools')).toHaveText('Camera');
    expect(spectator.query('.workspace-tools')).not.toHaveText('Multimodal');
    expect(spectator.query('.workspace-tools')).toHaveText('Home Assistant');
    expect(spectator.query('.workspace-tools')).toHaveText('Settings');
    expect(spectator.query('.tab-strip')).not.toExist();

    component.selectTab('messages');
    spectator.detectChanges();
    expect(spectator.query('.im-tab')).toExist();
    expect(spectator.query('.im-native-panel')).toExist();
    expect(spectator.query('.im-connector-row')).toExist();
    expect(spectator.query('input[type="radio"]')).toExist();
    expect(spectator.element.textContent).not.toContain('Route key');
    expect(spectator.element.textContent).not.toContain('route_key');
    const targetPreview = component.targetRoutePreview({
      target_id: 'target-visible-id',
      label: 'WeChat',
      route_key: 'gw_route_should_not_render',
    });
    expect(targetPreview).toBe('...ble-id');
    expect(targetPreview).not.toContain('render');

    component.selectTab('home-assistant');
    spectator.detectChanges();
    expect(spectator.query('.home-assistant-tab')).toExist();

    component.selectTab('settings');
    component.selectSettingsSection('ai');
    spectator.detectChanges();
    expect(spectator.query('.integrated-multimodal-panel')).not.toExist();

    component.selectSettingsSection('camera');
    spectator.detectChanges();
    expect(spectator.query('.devices-tab')).toExist();
    expect(spectator.query('.device-setup-stack')).toExist();
    expect(spectator.query('.simple-dvr-form')).toExist();
    expect(spectator.query('.device-edit-grid')).toExist();
    expect(spectator.query('.system-tab')).not.toExist();
  });

  it('shows Routing as model orchestration without exposing gateway route internals', () => {
    api.getRoutingStatus = jest.fn(() => of({
      kind: 'harborbeacon.routing_status.v1',
      generated_at: 'epoch_ms:1',
      metadata_only: true,
      scope: 'beacon_internal_orchestration',
      execution_routes: [
        {
          domain_id: 'harboros_system',
          display_name: 'HarborOS System Domain',
          owner_lane: 'harbor-hos-control',
          preferred_order: ['middleware_api', 'midcli'],
          boundary: 'system control stays separate from AIoT device-native control',
          status: 'active',
        },
      ],
      model_route_policies: [
        {
          route_policy_id: 'semantic.router',
          domain_scope: 'assistant',
          modality: 'text',
          privacy_level: 'strict_local',
          local_preferred: true,
          fallback_order: ['local', 'sidecar'],
          status: 'active',
          cloud_allowed: false,
          cloud_fallback_allowed: false,
          endpoint_counts: { local: 1, sidecar: 0, cloud: 0, disabled: 0 },
          selected_endpoint_id: 'llm-local',
          selected_endpoint_kind: 'local',
          blockers: [],
        },
      ],
      capability_readiness: [
        {
          capability_id: 'semantic_router',
          route_policy_id: 'semantic.router',
          readiness: 'ready',
          local_only: true,
          selected_endpoint_id: 'llm-local',
          blockers: [],
        },
      ],
      runtimes: [{ runtime_id: 'harbor-candle', status: 'ready', enabled: true, capabilities: ['llm'] }],
      boundaries: [
        {
          boundary_id: 'im_gateway_route_registry',
          owner_lane: 'harbor-im-gateway',
          status: 'external',
          note: 'route_key gw_route_should_not_render',
        },
      ],
      fallback_blockers: [],
      secret_scan: 'clean',
    }));

    spectator = createComponent({
      providers: [
        mockProvider(ActivatedRoute, {
          queryParamMap: of(convertToParamMap({ tab: 'settings', section: 'ai', focus: 'models' })),
        }),
      ],
    });
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      modelsAdvancedOpen: { set: (value: boolean) => void };
    };
    component.modelsAdvancedOpen.set(true);
    spectator.detectChanges();
    expect(spectator.query('[data-testid="harbor-assistant-routing-status"]')).toExist();
    expect(spectator.query('[data-testid="harbor-assistant-routing-status"]')).toHaveText('Routing status');
    expect(spectator.query('[data-testid="harbor-assistant-routing-status"]')).toHaveText('HarborOS System Domain');
    expect(spectator.query('[data-testid="harbor-assistant-routing-status"]')).toHaveText('semantic.router');
    expect(spectator.element.textContent).not.toContain('route_key');
    expect(spectator.element.textContent).not.toContain('gw_route_should_not_render');
  });

  it('shows Audit as governance metadata without rendering snapshots or secrets', () => {
    api.getAuditSummary = jest.fn(() => of({
      total: 1,
      window: '24h',
      by_entity_kind: { home_guardian: 1 },
      by_action: { evaluate_latest: 1 },
      by_actor_kind: { user: 1 },
      metadata_only: true,
      secret_scan: 'clean',
    }));
    api.getAuditRecords = jest.fn((limit = 12, cursor: string | null = null, filters: Record<string, string> = {}) => of({
      records: [
        {
          audit_id: cursor === '1' ? 'audit-page-2' : 'audit-1',
          workspace_id: 'home-1',
          entity_kind: filters.entity_kind || 'home_guardian',
          entity_id: filters.entity_id || 'C:\\secret\\camera-frame.jpg',
          action: filters.action || 'evaluate_latest',
          actor_kind: 'user',
          actor_id: 'local-admin',
          request_snapshot: { route_key: 'gw_route_should_not_render', token: 'secret-token' },
          result_snapshot: { raw_path: '/mnt/pool/private/frame.jpg', secret_scan: 'clean' },
          created_at: cursor === '1' ? 'epoch_ms:3' : 'epoch_ms:2',
        },
      ],
      total: 2,
      limit,
      cursor,
      next_cursor: cursor === '1' ? null : '1',
      metadata_only: true,
      secret_scan: 'clean',
    }));

    spectator = createComponent();
    const component = spectator.component as unknown as {
      auditFilterForm: { patchValue: (value: Record<string, string>) => void };
      toggleRulesDrawer: () => void;
      applyAuditFilters: () => void;
      nextAuditPage: () => void;
      previousAuditPage: () => void;
      resetAuditFilters: () => void;
    };
    component.toggleRulesDrawer();
    spectator.detectChanges();

    expect(spectator.query('[data-testid="harbor-assistant-audit-stream"]')).toExist();
    expect(spectator.query('[data-testid="harbor-assistant-audit-stream"]')).toHaveText('Audit stream');
    expect(spectator.query('[data-testid="harbor-assistant-audit-stream"]')).toHaveText('evaluate_latest');
    expect(spectator.query('[data-testid="harbor-assistant-audit-stream"]')).toHaveText('metadata only');
    expect(spectator.query('[data-testid="harbor-assistant-audit-stream"]')).toHaveText('Audit ID');
    expect(spectator.query('[data-testid="harbor-assistant-audit-stream"]')).toHaveText('Workspace');
    expect(spectator.query('[data-testid="harbor-assistant-audit-stream"]')).toHaveText('redacted');
    expect(spectator.element.textContent).not.toContain('route_key');
    expect(spectator.element.textContent).not.toContain('request_snapshot');
    expect(spectator.element.textContent).not.toContain('result_snapshot');
    expect(spectator.element.textContent).not.toContain('gw_route_should_not_render');
    expect(spectator.element.textContent).not.toContain('secret-token');
    expect(spectator.element.textContent).not.toContain('/mnt/pool/private');
    expect(spectator.element.textContent).not.toContain('C:\\secret');

    component.auditFilterForm.patchValue({
      entityKind: 'home_guardian',
      action: 'home_guardian.evaluate_latest',
      entityId: 'rule-front',
      limit: '25',
    });
    component.applyAuditFilters();
    spectator.detectChanges();

    expect(api.getAuditRecords).toHaveBeenLastCalledWith(25, null, {
      entity_kind: 'home_guardian',
      entity_id: 'rule-front',
      action: 'home_guardian.evaluate_latest',
    });
    expect(spectator.query('[data-testid="harbor-assistant-audit-stream"]')).toHaveText('audit-1');

    component.nextAuditPage();
    spectator.detectChanges();
    expect(api.getAuditRecords).toHaveBeenLastCalledWith(25, '1', {
      entity_kind: 'home_guardian',
      entity_id: 'rule-front',
      action: 'home_guardian.evaluate_latest',
    });
    expect(spectator.query('[data-testid="harbor-assistant-audit-stream"]')).toHaveText('audit-page-2');

    component.previousAuditPage();
    spectator.detectChanges();
    expect(api.getAuditRecords).toHaveBeenLastCalledWith(25, null, {
      entity_kind: 'home_guardian',
      entity_id: 'rule-front',
      action: 'home_guardian.evaluate_latest',
    });

    component.resetAuditFilters();
    spectator.detectChanges();
    expect(api.getAuditRecords).toHaveBeenLastCalledWith(12, null, {});
    expect(spectator.element.textContent).not.toContain('secret-token');
    expect(spectator.element.textContent).not.toContain('/mnt/pool/private');
  });

  it('renders device readiness diagnostics and runs a quick check without long stress controls', () => {
    spectator = createComponent({
      providers: [
        mockProvider(ActivatedRoute, {
          queryParamMap: of(convertToParamMap({ tab: 'settings', section: 'diagnostics' })),
        }),
      ],
    });
    spectator.detectChanges();

    expect(spectator.query('[data-testid="harbor-assistant-evt-readiness-panel"]')).toExist();
    expect(spectator.query('.evt-readiness-panel')).toHaveText('Device Readiness');
    expect(spectator.query('.evt-readiness-panel')).toHaveText('Device readiness');
    expect(spectator.query('.evt-readiness-panel')).not.toHaveText('k3-direct-72h-readiness');
    expect(spectator.query('.evt-readiness-panel')).not.toHaveText('operator supervisor');
    expect(spectator.query('.evt-readiness-panel')).toHaveText('Gateway and target');
    expect(spectator.query('.evt-readiness-panel')).toHaveText('Secret scan');
    expect(spectator.element.textContent).not.toContain('Start 72h');
    expect(spectator.element.textContent).not.toContain('Start 4h');

    const runPreflightButton = spectator.queryAll('button')
      .find((button) => button.textContent?.includes('Run quick check')) as HTMLButtonElement;
    spectator.click(runPreflightButton);
    spectator.detectChanges();

    expect(api.runEvtPreflight).toHaveBeenCalled();
    expect(spectator.query('.evt-readiness-panel')).toHaveText('88 ms');
    expect(spectator.query('.evt-readiness-panel')).not.toHaveText('long_run_started true');

    const viewEvidenceButton = spectator.queryAll('button')
      .find((button) => button.textContent?.includes('View redacted evidence')) as HTMLButtonElement;
    spectator.click(viewEvidenceButton);
    spectator.detectChanges();

    expect(api.getEvtEvidenceBundle).toHaveBeenCalled();
    expect(spectator.query('[data-testid="harbor-assistant-evt-evidence-json"]')).toHaveText('"redacted": true');
  });

  it('shows read-only local vision events in the camera tab', () => {
    api.getLocalVisionEvents = jest.fn(() => of({
      generated_at: 'epoch_ms:1',
      limit: 5,
      events: [
        {
          received_at: 'epoch_ms:1',
          event: {
            event_id: 'lve_1',
            camera_id: 'cam-real-231',
            event_type: 'person_detected',
            confidence: 0.92,
            labels: ['person', 'local_vision_event'],
            summary: 'Front door has a person.',
            snapshot_artifact: {
              artifact_id: 'artifact_1',
              path: null,
              mime_type: 'image/jpeg',
              byte_size: 12345,
              sha256: 'sha256-redacted',
              source: 'k3-local-snapshot',
            },
            started_at: 'epoch_ms:1',
            analyzer: 'yolov8n-cpu',
            latency_ms: 1370,
            metrics: {
              capture_read_ms: 80,
              frame_age_ms: 450,
              vlm_ms: 3200,
            },
            vlm: {
              status: 'active',
              summary: 'A person is standing near the front door.',
              derived_text: 'A person is standing near the front door.',
              tags: ['vlm'],
              labels: ['person'],
              artifacts: [],
              ingest_metadata: { frame_path_redacted: true },
              vlm_metrics: { elapsed_ms: 3200 },
            },
          },
          audit_record: {},
          ha_mqtt_payload: {},
        },
      ],
    }));
    spectator = createComponent({
      providers: [
        mockProvider(ActivatedRoute, {
          queryParamMap: of(convertToParamMap({ tab: 'camera' })),
        }),
      ],
    });
    spectator.detectChanges();
    (spectator.component as unknown as {
      state: { set: (value: unknown) => void };
      localVisionEvents: { set: (value: unknown[]) => void };
    }).state.set({ devices: [], defaults: {}, writable_root: '/var/lib/harbor' });
    (spectator.component as unknown as {
      localVisionEvents: { set: (value: unknown[]) => void };
    }).localVisionEvents.set([
      {
        received_at: 'epoch_ms:1',
        event: {
          event_id: 'lve_1',
          camera_id: 'cam-real-231',
          event_type: 'person_detected',
          confidence: 0.92,
          labels: ['person', 'local_vision_event'],
          summary: 'Front door has a person.',
          snapshot_artifact: {
            artifact_id: 'artifact_1',
            path: null,
            mime_type: 'image/jpeg',
            byte_size: 12345,
            sha256: 'sha256-redacted',
            source: 'k3-local-snapshot',
          },
          started_at: 'epoch_ms:1',
          analyzer: 'yolov8n-cpu',
          latency_ms: 1370,
          metrics: {
            capture_read_ms: 80,
            frame_age_ms: 450,
            vlm_ms: 3200,
          },
          vlm: {
            status: 'active',
            summary: 'A person is standing near the front door.',
            derived_text: 'A person is standing near the front door.',
            tags: ['vlm'],
            labels: ['person'],
            artifacts: [],
            ingest_metadata: { frame_path_redacted: true },
            vlm_metrics: { elapsed_ms: 3200 },
          },
        },
        audit_record: {},
        ha_mqtt_payload: {},
      },
    ]);
    spectator.detectChanges();

    expect(spectator.query('.event-intelligence-panel')).toExist();
    expect(spectator.query('.event-intelligence-panel')).toHaveText('Event intelligence');
    expect(spectator.query('.event-intelligence-panel')).toHaveText('A person is standing near the front door.');
    expect(spectator.query('.event-intelligence-panel')).toHaveText('cam-real-231');
    expect(spectator.query('.event-intelligence-panel')).toHaveText('92%');
    expect(spectator.element.textContent).not.toContain('rtsp://');
    expect(spectator.element.textContent).not.toContain('/tmp/');
    expect(spectator.element.textContent).not.toContain('camera_credential');
  });

  it('renders family timeline and Home Guardian controls without IM routing details', () => {
    api.getLocalVisionEvents = jest.fn(() => of({
      generated_at: 'epoch_ms:1',
      limit: 5,
      events: [storedLocalVisionEvent('lve_guardian_1')],
    }));
    api.getFamilyTimeline = jest.fn(() => of({
      generated_at: 'epoch_ms:2',
      window_seconds: 86400,
      event_count: 1,
      metadata_only: true,
      buckets: [{
        bucket_id: 'family_timeline_front_door',
        camera_id: 'front-door',
        started_at: 'epoch_ms:1',
        ended_at: 'epoch_ms:1',
        event_count: 1,
        event_types: ['person_detected'],
        top_labels: ['person'],
        event_ids: ['lve_guardian_1'],
      }],
      events: [],
    }));
    api.getFamilyTimelineDigest = jest.fn(() => of({
      generated_at: 'epoch_ms:2',
      status: 'available',
      window_seconds: 86400,
      event_count: 1,
      headline: '最近 24 小时记录到 1 条家庭视觉事件。',
      bullets: ['front-door: 1 条事件，主要标签 person。'],
      top_labels: ['person'],
      cameras: ['front-door'],
      latest_event_id: 'lve_guardian_1',
      metadata_only: true,
      secret_scan: 'clean',
      vlm_coverage: {
        total: 1,
        active: 1,
        degraded: 0,
        not_sampled: 0,
      },
      memory_overlay: familyMemoryStats({ event_count: 1 }),
    }));
    api.getFamilyMemoryEvents = jest.fn(() => of({
      generated_at: 'epoch_ms:2',
      limit: 50,
      metadata_only: true,
      secret_scan: 'clean',
      memory_overlay: familyMemoryStats({ event_count: 1 }),
      events: [{
        event_id: 'lve_guardian_1',
        camera_id: 'front-door',
        event_type: 'person_detected',
        summary: 'Courier at the front door.',
        confidence: 0.92,
        labels: ['person', 'courier'],
        started_at: 'epoch_ms:1',
        received_at: 'epoch_ms:1',
        latency_ms: 1370,
        vlm_status: 'active',
        artifact: {
          artifact_id: 'artifact_1',
          mime_type: 'image/jpeg',
          byte_size: 12345,
          sha256_present: true,
          local_path_redacted: true,
          raw_image_included: false,
        },
        overlay: {
          event_id: 'lve_guardian_1',
          confirmed_useful: false,
          favorite: false,
          hidden: false,
          corrected_summary: null,
          corrected_labels: null,
          corrected_at: null,
          updated_at: null,
          feedback_count: 0,
        },
      }],
    }));
    api.submitFamilyMemoryFeedback = jest.fn(() => of({
      status: 'stored',
      event_id: 'lve_guardian_1',
      feedback: {},
      memory_overlay: familyMemoryStats({ event_count: 1, favorite_count: 1 }),
      evidence: {},
      metadata_only: true,
      secret_scan: 'clean',
    }));
    api.getAutomationReviews = jest.fn(() => of({
      generated_at: 'epoch_ms:2',
      pending_count: 1,
      reviews: [homeGuardianReview('guardian_review_1', 'active')],
    }));
    api.getHomeGuardianActivity = jest.fn(() => of({
      generated_at: 'epoch_ms:2',
      rule_count: 1,
      active_count: 1,
      rules: [{
        review_id: 'guardian_review_1',
        status: 'active',
        metadata_only: true,
        route_key: 'gw_route_should_not_render',
      }],
      activity: [{
        run_id: 'guardian_run_1',
        event_id: 'lve_guardian_1',
        status: 'skipped',
        reason: 'idempotent duplicate event/action run',
        metadata_only: true,
        route_key: 'gw_route_should_not_render',
      }],
      counters: { skipped: 1 },
      metadata_only: true,
      secret_scan: 'clean',
    }));
    api.getHomeAssistantEntities = jest.fn(() => of({
      entities: [
        { entity_id: 'light.entry', domain: 'light', state: 'off', display_name: 'Entry light' },
        { entity_id: 'sensor.secret', domain: 'sensor', state: 'on', display_name: 'Sensor' },
      ],
    }));
    api.evaluateAutomationReviewLatest = jest.fn(() => of({
      evaluation_id: 'guardian_eval_1',
      status: 'evaluated',
      event_id: 'lve_guardian_1',
      evaluated_at: 'epoch_ms:3',
      results: [{
        review_id: 'guardian_review_1',
        status: 'skipped',
        matched: true,
        executed: false,
      }],
      counters: { skipped: 1 },
      metadata_only: true,
      secret_scan: 'clean',
    }));

    spectator = createComponent({
      providers: [
        mockProvider(ActivatedRoute, {
          queryParamMap: of(convertToParamMap({ tab: 'camera' })),
        }),
      ],
    });
    spectator.detectChanges();

    const panel = spectator.query('.event-intelligence-panel');
    expect(panel).toHaveText('Family Timeline');
    expect(panel).toHaveText('最近 24 小时记录到 1 条家庭视觉事件。');
    expect(panel).toHaveText('front-door');
    expect(panel).toHaveText('VLM coverage');
    expect(panel).toHaveText('Home Guardian');
    expect(panel).toHaveText('Memory Review');
    expect(panel).toHaveText('Courier at the front door.');
    expect(panel).toHaveText('VLM describe');
    expect(panel).toHaveText('1 rules');
    expect(panel).toHaveText('Entry light');
    expect(panel).not.toHaveText('sensor.secret');
    expect(spectator.element.textContent).not.toContain('route_key');
    expect(spectator.element.textContent).not.toContain('gw_route_should_not_render');
    expect(spectator.element.textContent).not.toContain('rtsp://');
    expect(spectator.element.textContent).not.toContain('/tmp/');
    expect(spectator.element.textContent).not.toContain('token=secret');

    const evaluateButton = spectator.queryAll('button')
      .find((button) => button.textContent?.includes('Evaluate latest')) as HTMLButtonElement;
    spectator.click(evaluateButton);
    spectator.detectChanges();

    expect(api.evaluateAutomationReviewLatest).toHaveBeenCalledWith('guardian_review_1');
    expect(panel).toHaveText('idempotent duplicate event/action run');

    const favoriteButton = spectator.queryAll('button')
      .find((button) => button.textContent?.trim() === 'Favorite') as HTMLButtonElement;
    spectator.click(favoriteButton);
    spectator.detectChanges();

    expect(api.submitFamilyMemoryFeedback).toHaveBeenCalledWith('lve_guardian_1', { action: 'favorite' });
  });

  it('runs VLM describe for an event and keeps the display redacted', () => {
    api.getLocalVisionEvents = jest.fn(() => of({
      generated_at: 'epoch_ms:1',
      limit: 5,
      events: [storedLocalVisionEvent('lve_vlm_1')],
    }));
    api.enrichVisionEventWithVlm = jest.fn(() => of({
      status: 'active',
      reason: 'enriched',
      event: storedLocalVisionEvent('lve_vlm_1'),
      metadata_only: true,
      secret_scan: 'clean',
    }));

    spectator = createComponent({
      providers: [
        mockProvider(ActivatedRoute, {
          queryParamMap: of(convertToParamMap({ tab: 'camera' })),
        }),
      ],
    });
    spectator.detectChanges();

    const describeButton = spectator.queryAll('button')
      .find((button) => button.textContent?.includes('VLM describe')) as HTMLButtonElement;
    spectator.click(describeButton);
    spectator.detectChanges();

    expect(api.enrichVisionEventWithVlm).toHaveBeenCalledWith('lve_vlm_1');
    expect(spectator.element.textContent).toContain('VLM summary attached to the event.');
    expect(spectator.element.textContent).not.toContain('rtsp://');
    expect(spectator.element.textContent).not.toContain('/tmp/');
    expect(spectator.element.textContent).not.toContain('route_key');
  });

  it('ignores removed tab aliases even when an old focus parameter is present', () => {
    spectator = createComponent({
      providers: [
        mockProvider(ActivatedRoute, {
          queryParamMap: of(convertToParamMap({ tab: 'devices', focus: 'models' })),
        }),
      ],
    });
    spectator.detectChanges();

    expect(spectator.query('.workspace-overview')).toExist();
    expect(spectator.query('ix-harbor-assistant-search')).not.toExist();
    expect(spectator.query('.settings-tab')).not.toExist();
    expect(spectator.query('.models-tab')).not.toExist();
  });

  it('selects exactly one default IM target from connector rows', () => {
    const defaultSubject = new Subject<unknown>();
    api.getNotificationTargets = jest.fn(() => of({
      targets: [
        { target_id: 'weixin-1', label: 'WeChat', platform_hint: 'weixin', is_default: true },
        { target_id: 'feishu-1', label: 'Feishu', platform_hint: 'feishu', is_default: false },
      ],
    }));
    api.setDefaultNotificationTarget = jest.fn(() => defaultSubject.asObservable());
    spectator = createComponent({
      providers: [
        mockProvider(ActivatedRoute, {
          queryParamMap: of(convertToParamMap({ tab: 'messages' })),
        }),
      ],
    });
    spectator.detectChanges();

    const radios = spectator.queryAll<HTMLInputElement>('input[type="radio"]');
    expect(radios.length).toBe(2);
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);

    spectator.click(radios[1]);
    spectator.detectChanges();

    expect(api.setDefaultNotificationTarget).toHaveBeenCalledWith('feishu-1');
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
    expect(spectator.query('.im-connector-list')).toHaveText('Saving...');

    defaultSubject.next({
      targets: [
        { target_id: 'weixin-1', label: 'WeChat', platform_hint: 'weixin', is_default: false },
        { target_id: 'feishu-1', label: 'Feishu', platform_hint: 'feishu', is_default: true },
      ],
    });
    defaultSubject.complete();
  });

  it('opens the model subtab and shows product capability names', () => {
    spectator = createComponent();

    spectator.click('[data-settings-section="models"]');
    spectator.detectChanges();

    const panel = spectator.query('.model-capability-list');
    expect(spectator.query('.model-capability-header')).toHaveText('Capability');
    expect(spectator.query('.model-capability-header')).toHaveText('Current model');
    expect(spectator.query('.model-capability-header')).toHaveText('Status');
    expect(spectator.query('.model-capability-header')).toHaveText('Actions');
    expect(panel).toHaveText('Question understanding');
    expect(panel).toHaveText('Vector search');
    expect(panel).toHaveText('Conversation answer');
    expect(panel).toHaveText('Image/video understanding');
    expect(panel).not.toHaveText('Speech-to-text');
    expect(panel).not.toHaveText('Event detection');
    expect(panel?.textContent?.toLowerCase()).not.toContain('detector');
    expect(router.navigate).toHaveBeenCalledWith([], expect.objectContaining({
      queryParams: {
        tab: 'settings', section: 'models', focus: null, node: null,
      },
    }));
  });

  it('summarizes healthy models only and still shows degraded current model names', () => {
    const degradedCurrentModel = (capabilityId: string, modelKind: string, modelName: string): Record<string, unknown> => ({
      capability_id: capabilityId,
      label: capabilityId,
      model_kind: modelKind,
      status: 'degraded',
      runtime_model_id: modelName,
      current_model: {
        model_endpoint_id: `${capabilityId}-local`,
        model_name: modelName,
        provider_key: 'openai_compatible',
        status: 'degraded',
      },
      installed_models: [],
      installable_models: [],
      download_jobs: [],
      next_action: '模型服务需要检查',
      runtime_ready: false,
    });
    const modelCapabilities = {
      generated_at: '1',
      checked_at: '1',
      status: 'degraded',
      capabilities: [
        degradedCurrentModel('semantic_router', 'llm', 'harbor-local-chat'),
        degradedCurrentModel('embedder', 'embedder', 'harbor-local-embed'),
        degradedCurrentModel('retrieval_answer', 'llm', 'harbor-local-chat'),
        degradedCurrentModel('vlm', 'vlm', 'vision'),
      ],
      blockers: [],
      warnings: [],
    };

    spectator = createComponent();
    const component = spectator.component as unknown as {
      modelCapabilitiesResponse: { set: (response: unknown) => void };
      aiSettingsTabs: () => Array<{ id: string; summary: string; tone: string }>;
      workflowCurrentModelName: (kind: string) => string;
      workflowCurrentModelDetail: (kind: string) => string;
    };
    component.modelCapabilitiesResponse.set(modelCapabilities);
    spectator.detectChanges();

    expect(component.aiSettingsTabs().find((tab) => tab.id === 'models')).toMatchObject({
      summary: '0/4 Ready',
      tone: 'danger',
    });
    expect(component.workflowCurrentModelName('semantic_router')).toBe('harbor-local-chat');
    expect(component.workflowCurrentModelDetail('semantic_router')).toBe('模型服务需要检查');
    expect(component.aiSettingsTabs().find((tab) => tab.id === 'models')?.summary).toBe('0/4 Ready');
    expect(spectator.query('.ai-settings-subtabs')).not.toExist();

    spectator.click('[data-settings-section="models"]');
    spectator.detectChanges();

    const questionRow = spectator.queryAll('.model-capability-row')[0];
    expect(questionRow).toHaveText('harbor-local-chat');
    expect(questionRow).toHaveText('模型服务需要检查');
    expect(questionRow).not.toHaveText('No model selected yet');
  });

  it('shows installed models only after opening the vector retrieval model chooser', () => {
    spectator = createComponent();

    spectator.click('[data-settings-section="models"]');
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      aiModelCapabilities: () => Array<{ id: string; kind: string }>;
      workflowModelChoices: (kind: string) => Array<{ displayName: string }>;
      toggleModelCapabilityChooser: (capability: { id: string; kind: string }) => void;
    };
    expect(component.workflowModelChoices('embedder').map((card) => card.displayName)).toContain('Harbor Embed Small');
    expect(spectator.query('.inline-model-panel')).not.toExist();

    component.toggleModelCapabilityChooser(component.aiModelCapabilities()[1]);
    spectator.detectChanges();

    expect(spectator.query('.model-capability-row .inline-model-panel')).toHaveText('Harbor Embed Small');
  });

  it('puts the More action inside an empty model chooser', () => {
    api.getLocalModelCatalog = jest.fn(() => of({
      models: [
        {
          model_id: 'harbor-vision-small',
          display_name: 'Harbor Vision Small',
          provider_key: 'local',
          model_kind: 'vlm',
          status: 'available',
          expected_capabilities: ['vision', 'video'],
          recommended_hardware: 'GPU',
          download_size_hint: '4 GiB',
        },
      ],
      download_jobs: [],
    }));
    spectator = createComponent();

    spectator.click('[data-settings-section="models"]');
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      aiModelCapabilities: () => Array<{ id: string; kind: string }>;
      toggleModelCapabilityChooser: (capability: { id: string; kind: string }) => void;
    };
    component.toggleModelCapabilityChooser(component.aiModelCapabilities()[1]);
    spectator.detectChanges();

    const emptyState = spectator.query('.model-capability-row .inline-empty-action');
    expect(emptyState).toHaveText('No installed models yet.');
    expect(emptyState).toHaveText('More models');

    spectator.click(spectator.query('.model-capability-row .inline-empty-action button'));
    spectator.detectChanges();

    expect(spectator.query('.model-library-card')).not.toExist();
    expect(spectator.query('.model-capability-row .inline-model-panel')).toHaveText('Hugging Face');
  });

  it('opens the Harbor Assistant folder browser and saves the selected folder as a data source', () => {
    spectator = createComponent({
      providers: [
        mockProvider(MatDialog, matDialog),
      ],
    });

    const component = spectator.component as unknown as {
      openKnowledgeFolderPicker: () => void;
    };
    component.openKnowledgeFolderPicker();
    spectator.detectChanges();

    expect(matDialog.open).toHaveBeenCalled();
    expect(api.saveKnowledgeSettings).toHaveBeenCalledWith(expect.objectContaining({
      source_roots: expect.arrayContaining([
        expect.objectContaining({ path: '/mnt/pool/videos', label: 'videos' }),
      ]),
    }));
    expect(spectator.query('.pending-source-card')).not.toExist();
  });

  it('starts Add data source from the Beacon workspace when the index root is under /mnt', () => {
    api.getKnowledgeSettings.mockReturnValue(of({
      source_roots: [],
      index_root: '/mnt/software/harborbeacon-agent-ci/knowledge-index',
      privacy_level: 'strict_local',
      default_resource_profile: 'cpu_only',
    }));
    spectator = createComponent({
      providers: [
        mockProvider(MatDialog, matDialog),
      ],
    });

    const component = spectator.component as unknown as {
      openKnowledgeFolderPicker: () => void;
    };
    component.openKnowledgeFolderPicker();
    spectator.detectChanges();

    expect(matDialog.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({
          currentPath: '/mnt/software/harborbeacon-agent-ci',
        }),
      }),
    );
  });

  it('uses Edit to choose a replacement folder for an existing data source', () => {
    spectator = createComponent({
      providers: [
        mockProvider(MatDialog, matDialog),
      ],
    });

    spectator.click('[data-settings-section="sources"]');
    spectator.click(spectator.query('.source-roots-card .table-row button'));
    spectator.detectChanges();

    expect(matDialog.open).toHaveBeenCalled();
    expect(api.saveKnowledgeSettings).toHaveBeenCalledWith(expect.objectContaining({
      source_roots: expect.arrayContaining([
        expect.objectContaining({ root_id: 'nas', path: '/mnt/pool/videos' }),
      ]),
    }));
  });

  it('keeps folder browsing inside Harbor Assistant instead of the global file manager picker', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/app/pages/harbor-assistant/harbor-assistant.component.ts'),
      'utf8',
    );

    expect(source).toContain('HarborAssistantFolderBrowserDialogComponent');
    expect(source).not.toContain('app/pages/file-manager/folder-picker-dialog/folder-picker-dialog.component');
  });

  it('shows model downloads inline only after the user asks for more models', () => {
    spectator = createComponent();
    spectator.detectChanges();

    expect(spectator.query('.model-library-card')).not.toExist();
    spectator.click('[data-settings-section="models"]');
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      aiModelCapabilities: () => Array<{ id: string; kind: string }>;
      openModelCapabilityMoreModels: (capability: { id: string; kind: string }) => void;
    };
    component.openModelCapabilityMoreModels(component.aiModelCapabilities()[1]);
    spectator.detectChanges();

    expect(spectator.query('.model-library-card')).not.toExist();
    expect(spectator.query('.model-capability-row .inline-model-panel')).toHaveText('Hugging Face');
    expect(spectator.query('.model-capability-row .inline-model-panel')).not.toHaveText('Harbor Vision Small');
  });

  it('shows failed download jobs with the error and a redownload action', () => {
    const failedJob = {
      job_id: 'job-qwen-failed',
      model_id: 'Qwen/Qwen3.5-4B',
      display_name: 'Qwen3.5 4B',
      provider_key: 'qwen',
      status: 'failed',
      target_path: '/mnt/models/qwen3.5-4b',
      progress_percent: 100,
      error_message: 'hf-mirror returned 404 for repo info',
      message: 'download failed',
      metadata: {},
    };
    api.getModelCapabilities = jest.fn(() => of(modelCapabilitiesWithEmbedder({
      status: 'needs_model',
      download_jobs: [failedJob],
    })));
    api.getLocalModelCatalog = jest.fn(() => of({
      models: [qwenCatalogModel({ status: 'needs-config' })],
      download_jobs: [failedJob],
    }));
    api.getLocalModelDownloads = jest.fn(() => of({ jobs: [failedJob] }));

    spectator = createComponent();
    spectator.click('[data-settings-section="models"]');
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      aiModelCapabilities: () => Array<{ id: string; kind: string }>;
      openModelCapabilityMoreModels: (capability: { id: string; kind: string }) => void;
    };
    component.openModelCapabilityMoreModels(component.aiModelCapabilities()[1]);
    spectator.detectChanges();

    const panel = spectator.query('.model-capability-row .inline-model-panel');
    expect(panel).toHaveText('Download failed');
    expect(panel).toHaveText('hf-mirror returned 404 for repo info');
    expect(panel).toHaveText('Download again');
    expect(panel).not.toHaveText('100%');
  });

  it('collapses repeated failed retries into the latest model download row', () => {
    const oldFailedJob = {
      job_id: 'job-qwen-old-failed',
      model_id: 'Qwen/Qwen3.5-4B',
      display_name: 'Qwen3.5 4B',
      provider_key: 'qwen',
      status: 'failed',
      requested_at: '1',
      updated_at: '1',
      target_path: '/mnt/models/qwen3.5-4b',
      progress_percent: 100,
      error_message: 'old hf-mirror 404',
      metadata: {},
    };
    const latestJob = {
      ...oldFailedJob,
      job_id: 'job-qwen-latest',
      status: 'downloading',
      requested_at: '2',
      updated_at: '3',
      progress_percent: 1,
      error_message: null,
    };
    api.getModelCapabilities = jest.fn(() => of(modelCapabilitiesWithEmbedder({
      status: 'downloading',
      download_jobs: [oldFailedJob, latestJob],
    })));
    api.getLocalModelCatalog = jest.fn(() => of({
      models: [qwenCatalogModel({ status: 'running' })],
      download_jobs: [oldFailedJob, latestJob],
    }));
    api.getLocalModelDownloads = jest.fn(() => of({ jobs: [oldFailedJob, latestJob] }));

    spectator = createComponent();
    spectator.click('[data-settings-section="models"]');
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      downloadJobs: () => Array<{ job_id: string; model_id: string }>;
      aiModelCapabilities: () => Array<{ id: string; kind: string }>;
      openModelCapabilityMoreModels: (capability: { id: string; kind: string }) => void;
    };
    expect(component.downloadJobs().map((job) => job.job_id)).toEqual(['job-qwen-latest']);

    component.openModelCapabilityMoreModels(component.aiModelCapabilities()[1]);
    spectator.detectChanges();

    const rows = spectator.queryAll('.model-capability-row .inline-model-panel .model-option-row');
    expect(rows.length).toBe(1);
    expect(rows[0]).toHaveText('Qwen3.5 4B');
    expect(rows[0]).toHaveText('1%');
    expect(rows[0]).not.toHaveText('old hf-mirror 404');
  });

  it('shows an accepted model selection immediately while retaining the actual running model', () => {
    const selection$ = new Subject<unknown>();
    const status$ = new Subject<unknown>();
    api.getModelCapabilities = jest.fn()
      .mockReturnValueOnce(of(routerSelectionCapabilities()))
      .mockReturnValue(status$);
    api.selectModelCapability = jest.fn(() => selection$);
    spectator = createComponent();
    const settingsCalls = api.getKnowledgeSettings?.mock.calls.length;
    spectator.click('[data-capability="semantic_router"] .row-actions button');
    const option = spectator.queryAll('[data-capability="semantic_router"] .model-option-row')
      .find((row) => row.textContent?.includes('Qwen2.5 0.5B'));
    spectator.click(option?.querySelector('button') as HTMLButtonElement);
    selection$.next(routerSelectionCapabilities({
      desired_model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
      selected_model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
      transition_status: 'loading',
    }));
    selection$.complete();
    spectator.detectChanges();

    const row = spectator.query('[data-capability="semantic_router"]');
    expect(row).toHaveText('Selected model: Qwen2.5 0.5B');
    expect(row).toHaveText('Currently running: Qwen3.8 27B');
    expect(row).toHaveText('Switching model');
    expect(row).toHaveText('Selected · switching');
    expect(row?.querySelector('.pill')).toHaveText('Switching');
    expect(row?.querySelector('.pill')).not.toHaveText('Ready');
    expect(spectator.query('[data-testid="model-projection-loading"]')).not.toExist();
    expect(api.getKnowledgeSettings?.mock.calls.length).toBe(settingsCalls);
    expect(api.selectModelCapability).toHaveBeenCalledWith('semantic_router', 'Qwen/Qwen2.5-0.5B-Instruct');
    expect(spectator.query('[data-capability="retrieval_answer"]')).not.toHaveText('Selected model: Qwen2.5');
  });

  it('shows a failed desired model without replacing the actual running model or hiding retry', () => {
    api.getModelCapabilities = jest.fn(() => of(routerSelectionCapabilities({
      desired_model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
      selected_model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
      transition_status: 'failed',
      last_error: 'The selected runtime could not start.',
    })));
    spectator = createComponent();
    spectator.click('[data-capability="semantic_router"] .row-actions button');
    const row = spectator.query('[data-capability="semantic_router"]');
    expect(row).toHaveText('Selected model: Qwen2.5 0.5B');
    expect(row).toHaveText('Currently running: Qwen3.8 27B');
    expect(row).toHaveText('Model switch failed');
    expect(row?.querySelector('.pill')).toHaveText('Switch failed');
    expect(row).toHaveText('The selected runtime could not start.');
    const option = spectator.queryAll('[data-capability="semantic_router"] .model-option-row')
      .find((candidate) => candidate.textContent?.includes('Qwen2.5 0.5B'));
    expect(option?.querySelector('button')).toHaveText('Retry');
    expect(option?.querySelector('button')).not.toBeDisabled();
  });

  it('refreshes shared model settings every five seconds only while Models is visible and on focus', fakeAsync(() => {
    api.getModelCapabilities = jest.fn(() => of(routerSelectionCapabilities()));
    spectator = createComponent();
    spectator.detectChanges();
    const initialCalls = api.getModelCapabilities.mock.calls.length;
    const settingsCalls = api.getKnowledgeSettings?.mock.calls.length;
    tick(5000);
    expect(api.getModelCapabilities.mock.calls).toHaveLength(initialCalls + 1);
    spectator.fixture.nativeElement.ownerDocument.defaultView.dispatchEvent(new Event('focus'));
    expect(api.getModelCapabilities.mock.calls).toHaveLength(initialCalls + 2);
    spectator.click('[data-settings-section="sources"]');
    spectator.detectChanges();
    tick(10000);
    spectator.fixture.nativeElement.ownerDocument.defaultView.dispatchEvent(new Event('focus'));
    expect(api.getModelCapabilities.mock.calls).toHaveLength(initialCalls + 2);
    expect(api.getKnowledgeSettings?.mock.calls.length).toBe(settingsCalls);
    spectator.fixture.destroy();
    discardPeriodicTasks();
  }));

  it('keeps the confirmed model and reports a rejected selection without creating endpoints', () => {
    api.getModelCapabilities = jest.fn(() => of(routerSelectionCapabilities()));
    api.selectModelCapability = jest.fn(() => throwError(() => new Error('Selection rejected by policy')));
    spectator = createComponent();
    const settingsCalls = api.getKnowledgeSettings?.mock.calls.length;
    spectator.click('[data-capability="semantic_router"] .row-actions button');
    const option = spectator.queryAll('[data-capability="semantic_router"] .model-option-row')
      .find((row) => row.textContent?.includes('Qwen2.5 0.5B'));
    spectator.click(option?.querySelector('button') as HTMLButtonElement);
    expect(spectator.query('[data-capability="semantic_router"] .model-current-cell')).toHaveText('Qwen3.8 27B');
    expect(spectator.query('[data-capability="semantic_router"] .model-current-cell'))
      .not.toHaveText('Selected model: Qwen2.5');
    expect(spectator.element.textContent).toContain('Selection rejected by policy');
    expect(spectator.element.textContent).not.toContain('Selecting model...');
    expect(api.createModelEndpoint).not.toHaveBeenCalled();
    expect(api.getKnowledgeSettings?.mock.calls.length).toBe(settingsCalls);
  });

  it('deduplicates installed and catalog entries while keeping separate runtime bindings', () => {
    const response = routerSelectionCapabilities() as { capabilities: Record<string, unknown>[] };
    const routerCapability = response.capabilities.find((capability) => capability['capability_id'] === 'semantic_router');
    if (routerCapability) {
      routerCapability['installable_models'] = routerCapability['installed_models'];
    }
    api.getModelCapabilities = jest.fn(() => of(response));
    api.getLocalModelCatalog = jest.fn(() => of({
      models: [{
        model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
        model_kind: 'llm',
        display_name: 'Qwen2.5 0.5B',
        status: 'available',
      }],
      download_jobs: [],
    }));
    spectator = createComponent();
    const component = spectator.component as unknown as {
      workflowModelChoices: (kind: string) => { modelId: string; section: string }[];
    };
    const choices = component.workflowModelChoices('semantic_router')
      .filter((card) => card.modelId === 'Qwen/Qwen2.5-0.5B-Instruct');
    expect(choices).toHaveLength(1);
    expect(choices[0].section).toBe('installed');
  });

  it('does not let an older full-page snapshot erase an accepted selection or its actual runtime', () => {
    const oldPage$ = new Subject<unknown>();
    const newStatus$ = new Subject<unknown>();
    api.getGatewayStatus = jest.fn().mockReturnValueOnce(of({})).mockReturnValue(oldPage$);
    api.getModelCapabilities = jest.fn()
      .mockReturnValueOnce(of(routerSelectionCapabilities()))
      .mockReturnValueOnce(of(routerSelectionCapabilities()))
      .mockReturnValue(newStatus$);
    api.selectModelCapability = jest.fn(() => of(routerSelectionCapabilities({
      desired_model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
      selected_model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
      transition_status: 'loading',
    })));
    spectator = createComponent();
    const component = spectator.component as unknown as {
      refresh: () => void;
      useInstalledModel: (card: { modelId: string; capabilityId: string; runtimeProfiles: string[] }) => void;
    };
    component.refresh();
    component.useInstalledModel({
      modelId: 'Qwen/Qwen2.5-0.5B-Instruct', capabilityId: 'semantic_router', runtimeProfiles: [],
    });
    oldPage$.next({});
    oldPage$.complete();
    spectator.detectChanges();
    expect(spectator.query('[data-capability="semantic_router"]')).toHaveText('Selected model: Qwen2.5 0.5B');
    expect(spectator.query('[data-capability="semantic_router"]')).toHaveText('Currently running: Qwen3.8 27B');
  });

  it('shows a server-side card selection on the next poll without waiting for unrelated model health', fakeAsync(() => {
    const slowHealth$ = new Subject<unknown>();
    api.selectModelCapability = jest.fn();
    api.getInferenceHealth = jest.fn().mockReturnValueOnce(of({ status: 'ready' })).mockReturnValue(slowHealth$);
    api.getModelCapabilities = jest.fn().mockReturnValueOnce(of(routerSelectionCapabilities()))
      .mockReturnValue(of(routerSelectionCapabilities({
        desired_model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
        selected_model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
        active_model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
        transition_status: 'ready',
      })));
    spectator = createComponent();
    spectator.detectChanges();
    tick(5000);
    spectator.detectChanges();
    expect(spectator.query('[data-capability="semantic_router"] .model-current-cell')).toHaveText('Qwen2.5 0.5B');
    expect(spectator.query('[data-capability="semantic_router"] .model-current-cell')).not.toHaveText('Qwen3.8 27B');
    expect(api.selectModelCapability).not.toHaveBeenCalled();
    spectator.fixture.destroy();
    discardPeriodicTasks();
  }));

  it('offers downloaded local models as selectable installed choices', () => {
    const installedModel = {
      model_id: 'Qwen/Qwen3.5-4B',
      display_name: 'Qwen3.5 4B',
      provider_key: 'qwen',
      model_kind: 'embedder',
      status: 'ready',
      installed: true,
      local_path: '/mnt/models/qwen3.5-4b',
      download_job_id: 'job-qwen-completed',
      source_kind: 'huggingface',
      repo_id: 'Qwen/Qwen3.5-4B',
      file_policy: 'runtime_snapshot',
      expected_capabilities: ['embedder'],
    };
    api.getModelCapabilities = jest.fn(() => of(modelCapabilitiesWithEmbedder({
      status: 'installed_not_running',
      installed_models: [installedModel],
    })));
    api.getLocalModelCatalog = jest.fn(() => of({
      models: [qwenCatalogModel({
        status: 'ready',
        installed: true,
        local_path: '/mnt/models/qwen3.5-4b',
      })],
      download_jobs: [],
    }));
    api.getLocalModelDownloads = jest.fn(() => of({
      jobs: [{
        job_id: 'job-qwen-completed',
        model_id: 'Qwen/Qwen3.5-4B',
        display_name: 'Qwen3.5 4B',
        provider_key: 'qwen',
        status: 'completed',
        target_path: '/mnt/models/qwen3.5-4b',
        progress_percent: 100,
        metadata: {},
      }],
    }));

    spectator = createComponent();
    spectator.click('[data-settings-section="models"]');
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      aiModelCapabilities: () => Array<{ id: string; kind: string }>;
      toggleModelCapabilityChooser: (capability: { id: string; kind: string }) => void;
    };
    component.toggleModelCapabilityChooser(component.aiModelCapabilities()[1]);
    spectator.detectChanges();

    const panel = spectator.query('.model-capability-row .inline-model-panel');
    expect(panel).toHaveText('Qwen3.5 4B');
    expect(panel).toHaveText('Qwen/Qwen3.5-4B');
    expect(panel).not.toHaveText('/mnt/models/qwen3.5-4b');
    expect(panel).toHaveText('Select');
  });

  it('treats choosing an installed model as a runtime start request', () => {
    const installedModel = {
      model_id: 'Qwen/Qwen3.5-4B',
      display_name: 'Qwen3.5 4B',
      provider_key: 'qwen',
      model_kind: 'embedder',
      status: 'ready',
      installed: true,
      local_path: '/mnt/models/qwen3.5-4b',
      source_kind: 'huggingface',
      repo_id: 'Qwen/Qwen3.5-4B',
      file_policy: 'runtime_snapshot',
      expected_capabilities: ['embedder'],
    };
    api.getModelCapabilities = jest.fn(() => of(modelCapabilitiesWithEmbedder({
      status: 'installed_not_running',
      runtime_model_id: '/models/old-embed.gguf',
      runtime_ready: true,
      current_model: {
        model_endpoint_id: 'embedder-local',
        model_name: '/models/old-embed.gguf',
        provider_key: 'local',
        status: 'active',
      },
      installed_models: [installedModel],
    })));
    api.selectModelCapability = jest.fn(() => of(modelCapabilitiesWithEmbedder({
      status: 'installed_not_running',
      selected_model_id: 'Qwen/Qwen3.5-4B',
      runtime_model_id: '/models/old-embed.gguf',
      runtime_ready: true,
      installed_models: [installedModel],
    })));

    spectator = createComponent();
    spectator.click('[data-settings-section="models"]');
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      aiModelCapabilities: () => Array<{ id: string; kind: string }>;
      toggleModelCapabilityChooser: (capability: { id: string; kind: string }) => void;
    };
    component.toggleModelCapabilityChooser(component.aiModelCapabilities()[1]);
    spectator.detectChanges();

    spectator.click(spectator.query('.model-capability-row .inline-model-panel button'));
    spectator.detectChanges();

    expect(api.selectModelCapability).toHaveBeenCalledWith('embedder', 'Qwen/Qwen3.5-4B');
    expect(spectator.element.textContent).toContain('Model startup has been requested');
    expect(spectator.element.textContent).not.toContain('compatible runtime');
  });

  it('uses backend selection for an external installed asset without inventing an active endpoint', () => {
    const installedModel = {
      model_id: 'Qwen/Qwen3-Embedding-0.6B',
      display_name: 'Qwen3 Embedding 0.6B',
      provider_key: 'qwen',
      model_kind: 'embedder',
      status: 'ready',
      installed: true,
      local_path: '/mnt/models/qwen-embedding',
      runtime_profiles: ['openai-compatible-embedding'],
    };
    api.getModelCapabilities = jest.fn(() => of(modelCapabilitiesWithEmbedder({ installed_models: [installedModel] })));
    api.selectModelCapability = jest.fn(() => of(modelCapabilitiesWithEmbedder({
      desired_model_id: installedModel.model_id,
      selected_model_id: installedModel.model_id,
      active_model_id: null,
      transition_status: 'failed',
      last_error: 'No matching runtime is available.',
    })));
    spectator = createComponent();
    spectator.click('[data-capability="embedder"] .row-actions button');
    const option = spectator.queryAll('[data-capability="embedder"] .model-option-row')
      .find((row) => row.textContent?.includes('Qwen3 Embedding 0.6B'));
    expect(option).toHaveText('Requires a configured compatible runtime. Select the model when it is ready.');
    expect(option).not.toHaveText('configure the endpoint automatically');
    spectator.click(option?.querySelector('button') as HTMLButtonElement);
    expect(api.selectModelCapability).toHaveBeenCalledWith('embedder', installedModel.model_id);
    expect(api.updateModelEndpoint).not.toHaveBeenCalled();
    expect(api.createModelEndpoint).not.toHaveBeenCalled();
    expect(spectator.element.textContent).toContain('No matching runtime is available.');
  });

  it('groups installed 4B as not recommended and keeps FlashV4 visible as cloud backup', () => {
    api.getHardwareReadiness = jest.fn(() => of({
      status: 'ready',
      cpu: { status: 'ready', summary: 'ready', detail: 'ready', evidence: [] },
      memory: { status: 'ready', summary: '11.7 GiB', detail: 'ready', evidence: [] },
      gpu: { status: 'warn', summary: 'No confirmed GPU memory', detail: 'ready', evidence: [] },
      npu: { status: 'warn', summary: 'No NPU', detail: 'ready', evidence: [] },
      memory_mb: 11980,
      gpu_vram_total_mb: null,
      hardware_class: 'tiny_cpu',
      recommended_model_profile: 'lightweight-local-models',
    }));
    api.getModelEndpoints = jest.fn(() => of({
      endpoints: [
        modelEndpoint('llm-local', 'llm', '/models/chat.gguf'),
        {
          model_endpoint_id: 'llm-cloud-siliconflow',
          model_kind: 'llm',
          endpoint_kind: 'cloud',
          provider_key: 'openai_compatible',
          model_name: 'deepseek-ai/DeepSeek-V4-Flash',
          capability_tags: ['chat'],
          cost_policy: {},
          status: 'disabled',
          metadata: {
            provider: 'siliconflow',
            provider_label: 'SiliconFlow',
            base_url: 'https://api.siliconflow.cn/v1',
            api_key_configured: false,
          },
        },
      ],
    }));
    api.getLocalModelCatalog = jest.fn(() => of({
      models: [
        qwenCatalogModel({
          model_kind: 'llm',
          installed: true,
          status: 'ready',
          local_path: '/mnt/software/harborbeacon-agent-ci/model-store/qwen-qwen3.5-4b',
          expected_capabilities: ['chat'],
          hardware_fit: 'not_recommended',
          fit_reason: '4B model is installed, but current hardware has no confirmed 16GB+ usable GPU memory.',
          recommendation_group: 'installed_not_recommended',
        }),
        {
          model_id: 'qwen2.5-1.5b-instruct',
          display_name: 'Qwen2.5 1.5B Instruct',
          provider_key: 'qwen',
          model_kind: 'llm',
          source_kind: 'huggingface',
          status: 'available',
          installable: true,
          manual_only: false,
          repo_id: 'Qwen/Qwen2.5-1.5B-Instruct',
          revision: 'main',
          file_policy: 'runtime_snapshot',
          expected_capabilities: ['chat'],
          recommended_hardware: 'CPU',
          download_size_hint: '2 GiB',
          hardware_fit: 'recommended',
          fit_reason: 'Lightweight local profile fits the current machine.',
          recommendation_group: 'lightweight_local',
        },
      ],
      download_jobs: [],
    }));

    spectator = createComponent();
    spectator.click('[data-settings-section="models"]');
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      workflowModelChoices: (kind: string) => Array<{ displayName: string; actionLabel: string; errorMessage: string | null }>;
      modelRecommendationLabel: (card: unknown) => string;
      modelHardwareFitLabel: (card: unknown) => string;
    };
    const choices = component.workflowModelChoices('semantic_router');
    const qwen4b = choices.find((card) => card.displayName === 'Qwen3.5 4B');
    const qwen25 = choices.find((card) => card.displayName === 'Qwen2.5 1.5B Instruct');
    const flash = choices.find((card) => card.displayName === 'deepseek-ai/DeepSeek-V4-Flash');

    expect(qwen4b).toBeTruthy();
    expect(component.modelRecommendationLabel(qwen4b)).toBe('Installed but not recommended for this hardware');
    expect(component.modelHardwareFitLabel(qwen4b)).toBe('Not recommended for this hardware');
    expect(qwen25).toBeTruthy();
    expect(component.modelRecommendationLabel(qwen25)).toBe('Lightweight local');
    expect(flash).toBeTruthy();
    expect(component.modelRecommendationLabel(flash)).toBe('Cloud backup');
    expect(flash?.actionLabel).toBe('Configure API key');
    expect(flash?.errorMessage).toContain('FlashV4 is not missing');
  });

  it('starts BGE M3 from Hugging Face metadata instead of asking for a manual URL', () => {
    api.getModelCapabilities = jest.fn(() => of(modelCapabilitiesWithEmbedder({
      status: 'needs_model',
      current_model: null,
      runtime_ready: false,
    })));
    api.getLocalModelCatalog = jest.fn(() => of({
      models: [
        {
          model_id: 'bge-m3',
          display_name: 'BGE M3 Embedding',
          provider_key: 'bge',
          model_kind: 'embedder',
          source_kind: 'huggingface',
          status: 'available',
          installable: true,
          manual_only: false,
          repo_id: 'BAAI/bge-m3',
          revision: 'main',
          file_policy: 'runtime_snapshot',
          expected_capabilities: ['embedding'],
          recommended_hardware: 'CPU',
          download_size_hint: '1-2 GB',
          hardware_fit: 'recommended',
          fit_reason: 'Lightweight local profile fits the current machine.',
          recommendation_group: 'lightweight_local',
        },
      ],
      download_jobs: [],
    }));

    spectator = createComponent();
    spectator.click('[data-settings-section="models"]');
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      workflowAvailableModelChoices: (kind: string) => Array<unknown>;
      handleModelCardAction: (card: unknown) => void;
    };
    const bge = component.workflowAvailableModelChoices('embedder')[0];
    expect((bge as { actionLabel: string }).actionLabel).toBe('Select');
    component.handleModelCardAction(bge);
    spectator.detectChanges();
    expect(spectator.element.textContent)
      .toContain('Select the model after completion when a compatible runtime is available.');
    expect(spectator.element.textContent).not.toContain('will select and enable it automatically');

    expect(api.createLocalModelDownload).toHaveBeenCalledWith(expect.objectContaining({
      model_id: 'bge-m3',
      metadata: expect.objectContaining({
        auto_select_after_download: true,
        auto_select_capability_id: 'embedder',
        auto_select_model_id: 'bge-m3',
        repo_id: 'BAAI/bge-m3',
        source_kind: 'huggingface',
        file_policy: 'runtime_snapshot',
      }),
    }));
  });

  it('normalizes scan CIDR defaults and sends RTSP port separately', () => {
    api.getState = jest.fn(() => of({
      devices: [],
      defaults: {
        cidr: '192.168.3.0/554',
        discovery: 'RTSP',
        rtsp_port: 554,
      },
      writable_root: '/var/lib/harbor',
    }));

    spectator = createComponent();
    const component = spectator.component as unknown as {
      selectTab: (tab: 'settings') => void;
      selectSettingsSection: (section: 'camera') => void;
      scanForm: { controls: { cidr: { value: string }; rtspPort: { value: string }; username: { value: string }; password: { value: string } } };
      scanDevices: () => void;
    };
    component.selectTab('settings');
    component.selectSettingsSection('ai');
    spectator.detectChanges();
    expect(spectator.query('.integrated-multimodal-panel')).not.toExist();

    component.selectSettingsSection('camera');
    spectator.detectChanges();

    expect(component.scanForm.controls.cidr.value).toBe('192.168.3.0/24');
    expect(component.scanForm.controls.rtspPort.value).toBe('554');
    expect(component.scanForm.controls.password.value).toBe('');

    component.scanDevices();
    expect(api.scanDevices).toHaveBeenCalledWith({
      cidr: '192.168.3.0/24',
      protocol: 'RTSP',
      rtsp_port: 554,
      rtsp_username: null,
      rtsp_password: null,
    });
  });

  it('shows password-required scan results instead of silently adding a protected camera', () => {
    api.scanDevices = jest.fn(() => of({
      scanned_hosts: 1,
      devices: [],
      defaults: {
        cidr: '192.168.3.0/24',
        discovery: 'RTSP',
        rtsp_port: 554,
        rtsp_username: 'admin',
      },
      results: [{
        candidate_id: 'rtsp-192-168-3-231',
        device_id: null,
        name: 'Camera 192.168.3.231',
        room: 'Pending identification',
        ip: '192.168.3.231',
        port: 554,
        protocol: 'RTSP / 需密码',
        note: '摄像头需要密码。',
        reachable: false,
        registered: false,
        requires_auth: true,
        rtsp_paths: ['/stream1'],
      }],
    }));

    spectator = createComponent();
    const component = spectator.component as unknown as {
      selectTab: (tab: 'settings') => void;
      selectSettingsSection: (section: 'camera') => void;
      scanDevices: () => void;
    };
    component.selectTab('settings');
    component.selectSettingsSection('ai');
    spectator.detectChanges();
    expect(spectator.query('.integrated-multimodal-panel')).not.toExist();

    component.selectSettingsSection('camera');
    spectator.detectChanges();

    component.scanDevices();
    spectator.detectChanges();

    expect(spectator.element.textContent).toContain('Cameras that require a password were found');
    expect(spectator.element.textContent).toContain('Enter password to connect');
    expect(spectator.element.textContent).toContain('RTSP / 需密码');
  });

  it('lets a password-required scan result be connected inline with credentials', () => {
    api.scanDevices = jest.fn(() => of({
      scanned_hosts: 1,
      devices: [],
      defaults: {
        cidr: '192.168.3.0/24',
        discovery: 'RTSP',
        rtsp_port: 554,
        rtsp_username: 'admin',
      },
      results: [{
        candidate_id: 'rtsp-192-168-3-231',
        device_id: null,
        name: 'Camera 192.168.3.231',
        room: 'Pending identification',
        ip: '192.168.3.231',
        port: 554,
        protocol: 'RTSP / 需密码',
        note: '摄像头需要密码。',
        reachable: false,
        registered: false,
        requires_auth: true,
        rtsp_paths: ['/stream1'],
      }],
    }));
    api.addManualDevice = jest.fn(() => of({ devices: [], defaults: {}, writable_root: '/var/lib/harbor' }));

    spectator = createComponent();
    const component = spectator.component as unknown as {
      selectTab: (tab: 'settings') => void;
      selectSettingsSection: (section: 'camera') => void;
      scanDevices: () => void;
      scanResults: () => Array<{
        candidate_id: string;
        name: string;
        room: string;
        ip: string;
        port: number;
        rtsp_paths?: string[];
      }>;
      prepareManualFromScan: (result: unknown) => void;
      scanCredentialForm: { patchValue: (value: { username: string; password: string }) => void };
      toggleScanCredentialPasswordVisible: () => void;
      connectScanResult: (result: unknown) => void;
    };
    component.selectTab('settings');
    component.selectSettingsSection('ai');
    spectator.detectChanges();
    expect(spectator.query('.integrated-multimodal-panel')).not.toExist();

    component.selectSettingsSection('camera');
    spectator.detectChanges();

    component.scanDevices();
    spectator.detectChanges();
    const result = component.scanResults()[0];
    component.prepareManualFromScan(result);
    spectator.detectChanges();

    expect(spectator.query('.scan-credential-form')).toHaveText('Username');
    expect(spectator.query('.scan-credential-form')).toHaveText('Password');
    expect(spectator.query('.scan-credential-form')).toHaveText('Connect camera');
    expect(spectator.query('.password-visibility-button')).toExist();

    const passwordInput = spectator.query<HTMLInputElement>('.scan-credential-form input[formcontrolname="password"]');
    expect(passwordInput?.type).toBe('password');
    component.toggleScanCredentialPasswordVisible();
    spectator.detectChanges();
    expect(spectator.query<HTMLInputElement>('.scan-credential-form input[formcontrolname="password"]')?.type).toBe('text');

    component.scanCredentialForm.patchValue({ username: 'admin', password: 'secret' });
    component.connectScanResult(result);

    expect(api.addManualDevice).toHaveBeenCalledWith({
      name: 'Camera 192.168.3.231',
      room: null,
      ip: '192.168.3.231',
      path: '/stream1',
      snapshot_url: null,
      username: 'admin',
      password: 'secret',
      port: 554,
    });
  });

  it('keeps scan credential failures visible on the scan result row', () => {
    api.scanDevices = jest.fn(() => of({
      scanned_hosts: 1,
      devices: [],
      defaults: {
        cidr: '192.168.3.0/24',
        discovery: 'RTSP',
        rtsp_port: 554,
        rtsp_username: 'admin',
      },
      results: [{
        candidate_id: 'rtsp-192-168-3-231',
        device_id: null,
        name: 'Camera 192.168.3.231',
        room: 'Pending identification',
        ip: '192.168.3.231',
        port: 554,
        protocol: 'RTSP / 需密码',
        note: '摄像头需要密码。',
        reachable: false,
        registered: false,
        requires_auth: true,
        rtsp_paths: ['/stream1'],
      }],
    }));
    api.addManualDevice = jest.fn(() => throwError(() => ({ error: { error: 'RTSP authentication failed' } })));

    spectator = createComponent();
    const component = spectator.component as unknown as {
      selectTab: (tab: 'settings') => void;
      selectSettingsSection: (section: 'camera') => void;
      scanDevices: () => void;
      scanResults: () => Array<{
        candidate_id: string;
        name: string;
        room: string;
        ip: string;
        port: number;
        rtsp_paths?: string[];
      }>;
      prepareManualFromScan: (result: unknown) => void;
      scanCredentialForm: { patchValue: (value: { username: string; password: string }) => void };
      connectScanResult: (result: unknown) => void;
    };
    component.selectTab('settings');
    component.selectSettingsSection('ai');
    spectator.detectChanges();
    expect(spectator.query('.integrated-multimodal-panel')).not.toExist();

    component.selectSettingsSection('camera');
    spectator.detectChanges();

    component.scanDevices();
    spectator.detectChanges();
    const result = component.scanResults()[0];
    component.prepareManualFromScan(result);
    component.scanCredentialForm.patchValue({ username: 'admin', password: 'bad-secret' });
    component.connectScanResult(result);
    spectator.detectChanges();

    expect(spectator.query('.scan-credential-form')).toHaveText('RTSP authentication failed');
    expect(spectator.query('.scan-credential-form')).toHaveText('Connect camera');
  });

  it('requires a second click before deleting a camera and uses readable confirmation controls', () => {
    const device = {
      device_id: 'cam-tp1',
      name: 'TP1',
      room: '客厅',
      ip_address: '192.168.3.231',
      status: 'ready',
      vendor: 'TP-Link',
      model: 'Tapo',
      discovery_source: 'manual',
    };
    api.getState = jest.fn(() => of({
      devices: [device],
      defaults: {
        selected_camera_device_id: null,
        cidr: '192.168.3.0/24',
        rtsp_port: 554,
      },
      writable_root: '/var/lib/harbor',
    }));
    api.deleteDevice = jest.fn(() => of({
      devices: [],
      defaults: {
        selected_camera_device_id: null,
        rtsp_username: 'admin',
        rtsp_password: '',
      },
      writable_root: '/var/lib/harbor',
    }));

    spectator = createComponent();
    const component = spectator.component as unknown as {
      selectTab: (tab: 'settings') => void;
      selectSettingsSection: (section: 'camera') => void;
    };
    component.selectTab('settings');
    component.selectSettingsSection('ai');
    spectator.detectChanges();
    expect(spectator.query('.integrated-multimodal-panel')).not.toExist();

    component.selectSettingsSection('camera');
    spectator.detectChanges();

    const deleteButton = spectator.queryAll<HTMLButtonElement>('.device-actions button')
      .find((button) => button.textContent?.includes('Delete'));
    expect(deleteButton).toBeTruthy();
    expect(deleteButton?.classList.contains('delete-button')).toBe(true);
    expect(deleteButton?.getAttribute('color')).toBeNull();
    spectator.click(deleteButton);
    spectator.detectChanges();

    expect(api.deleteDevice).not.toHaveBeenCalled();
    const confirmButton = spectator.query<HTMLButtonElement>('.confirm-delete-button');
    expect(confirmButton).toHaveText('Confirm delete');
    expect(confirmButton?.getAttribute('color')).toBeNull();
    expect(spectator.element.textContent).toContain('Cancel');

    spectator.click(confirmButton);
    expect(api.deleteDevice).toHaveBeenCalledWith('cam-tp1');
  });

  it('keeps Cloud API configuration collapsed within Models and restores its legacy focus', () => {
    spectator = createComponent();
    spectator.detectChanges();

    expect(spectator.query('details.cloud-model-settings')).not.toHaveAttribute('open');
    expect(spectator.query('.model-capability-list')).toExist();

    const component = spectator.component as unknown as {
      selectAiSettingsTab: (tab: 'cloud-api') => void;
    };
    component.selectAiSettingsTab('cloud-api');
    spectator.detectChanges();

    expect(spectator.query('mat-select[formcontrolname="provider"]')).toExist();
    expect(spectator.query('[formcontrolname="baseUrl"]')).toExist();
    expect(spectator.query('.cloud-api-panel')?.textContent?.toLowerCase()).not.toContain('fallback order');
  });

  it('saves API key settings without echoing or clearing an existing key', () => {
    spectator = createComponent();

    const component = spectator.component as unknown as {
      selectAiSettingsTab: (tab: 'cloud-api') => void;
      cloudApiForm: {
        patchValue: (value: Record<string, unknown>) => void;
      };
      saveCloudApiSettings: () => void;
    };
    component.selectAiSettingsTab('cloud-api');
    component.cloudApiForm.patchValue({
      provider: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      modelName: 'deepseek-ai/DeepSeek-V4-Flash',
      apiKey: '',
      usageMode: 'selected_capabilities',
      allowQuestionUnderstanding: true,
      allowAnswer: false,
    });
    component.saveCloudApiSettings();

    expect(api.updateModelEndpoint).toHaveBeenCalledWith('llm-cloud-siliconflow', expect.objectContaining({
      metadata: expect.objectContaining({
        api_key_configured: true,
        base_url: 'https://api.siliconflow.cn/v1',
      }),
    }));
    const payload = api.updateModelEndpoint.mock.calls[0][1] as { metadata: Record<string, unknown> };
    expect(payload.metadata.api_key).toBeUndefined();
    expect(api.saveModelPolicies).toHaveBeenCalledWith(expect.objectContaining({
      route_policies: expect.arrayContaining([
        expect.objectContaining({
          route_policy_id: 'semantic.router',
          privacy_level: 'allow_redacted_cloud',
          fallback_order: ['local', 'sidecar', 'cloud'],
        }),
        expect.objectContaining({
          route_policy_id: 'retrieval.answer',
          privacy_level: 'strict_local',
          fallback_order: ['local', 'sidecar'],
        }),
      ]),
    }));
  });
});

function familyMemoryStats(overrides: Record<string, number> = {}): Record<string, unknown> {
  return {
    generated_at: 'epoch_ms:0',
    total_feedback_records: overrides['total_feedback_records'] ?? 0,
    event_count: overrides['event_count'] ?? 0,
    confirmed_count: overrides['confirmed_count'] ?? 0,
    favorite_count: overrides['favorite_count'] ?? 0,
    hidden_count: overrides['hidden_count'] ?? 0,
    corrected_count: overrides['corrected_count'] ?? 0,
    bounded_limit: 5000,
    metadata_only: true,
    secret_scan: 'clean',
  };
}

function storedLocalVisionEvent(eventId: string): unknown {
  return {
    received_at: 'epoch_ms:1',
    event: {
      event_id: eventId,
      camera_id: 'front-door',
      event_type: 'person_detected',
      confidence: 0.92,
      labels: ['person', 'local_vision_event'],
      summary: 'Front door has a person.',
      snapshot_artifact: {
        artifact_id: 'artifact_1',
        path: null,
        mime_type: 'image/jpeg',
        byte_size: 12345,
        sha256: 'sha256-redacted',
        source: 'k3-local-snapshot',
      },
      started_at: 'epoch_ms:1',
      analyzer: 'yolov8n-cpu',
      latency_ms: 1370,
      metrics: {
        capture_read_ms: 80,
        frame_age_ms: 450,
        vlm_ms: 3200,
      },
      vlm: {
        status: 'active',
        summary: 'A person is standing near the front door.',
        derived_text: 'A person is standing near the front door.',
        tags: ['vlm'],
        labels: ['person'],
        artifacts: [],
        ingest_metadata: { frame_path_redacted: true },
        vlm_metrics: { elapsed_ms: 3200 },
      },
    },
    audit_record: {
      metadata_only: true,
      route_key: 'gw_route_should_not_render',
    },
    ha_mqtt_payload: {
      metadata_only: true,
    },
  };
}

function homeGuardianReview(reviewId: string, status: string): unknown {
  return {
    review_id: reviewId,
    workspace_id: 'home-1',
    source: 'home_guardian',
    source_channel: 'HarborAssistant Camera',
    source_conversation_id: null,
    original_prompt: 'Notify me when the front door sees a person.',
    status,
    trigger_definition: {
      camera_id: 'front-door',
      event_type: 'person_detected',
      labels: ['person'],
      metadata_only: true,
    },
    action_plan: {
      actions: [{ kind: 'notify_default_target' }],
      metadata_only: true,
    },
    device_refs: [{ camera_id: 'front-door' }],
    risk_level: 'low',
    requires_approval: true,
    rule_id: 'guardian_rule_1',
    run_summaries: [],
    metadata: {
      feature: 'home_guardian',
      home_guardian: true,
      metadata_only: true,
      route_key: 'gw_route_should_not_render',
    },
  };
}

function harborAssistantApiMock(): Partial<Record<keyof HarborAssistantApiService, jest.Mock>> {
  const statusComponent = { status: 'ready', summary: 'ready', detail: 'ready', evidence: [] };
  return {
    getState: jest.fn(() => of({ devices: [], defaults: {}, writable_root: '/var/lib/harbor' })),
    scanDevices: jest.fn((payload) => of(payload)),
    deleteDevice: jest.fn(() => of({ devices: [], defaults: {}, writable_root: '/var/lib/harbor' })),
    getDeviceEvidence: jest.fn(() => of({ results: [] })),
    getGatewayStatus: jest.fn(() => of({ status: 'ready', channels: [] })),
    getInferenceHealth: jest.fn(() => of({ status: 'ready', ready: true })),
    getAutomationReviews: jest.fn(() => of({ reviews: [] })),
    getNotificationTargets: jest.fn(() => of({ targets: [] })),
    setDefaultNotificationTarget: jest.fn(() => of({ ok: true })),
    deleteNotificationTarget: jest.fn(() => of({ ok: true })),
    getModelEndpoints: jest.fn(() => of({
      endpoints: [
        modelEndpoint('embedder-local', 'embedder', '/models/embed.gguf'),
        modelEndpoint('llm-local', 'llm', '/models/chat.gguf'),
        {
          ...(modelEndpoint('llm-cloud-siliconflow', 'llm', 'deepseek-ai/DeepSeek-V4-Flash') as Record<string, unknown>),
          endpoint_kind: 'cloud',
          provider_key: 'openai_compatible',
          status: 'active',
          metadata: {
            provider: 'siliconflow',
            provider_label: 'SiliconFlow',
            base_url: 'https://api.siliconflow.cn/v1',
            api_key_configured: true,
          },
        },
      ],
    })),
    createModelEndpoint: jest.fn((payload) => of({ endpoints: [payload] })),
    updateModelEndpoint: jest.fn((id, payload) => of({ endpoints: [{ ...payload, model_endpoint_id: id }] })),
    testModelEndpoint: jest.fn(() => of({ ok: true, status: 'active', summary: 'ok' })),
    getModelRuntimes: jest.fn(() => of(defaultRuntimeManager())),
    installModelRuntime: jest.fn((runtimeId) => of({
      runtime: {
        ...(defaultRuntimeManager().runtimes.find((runtime) => runtime.runtime_id === runtimeId) ?? {}),
        installed: true,
        enabled: true,
        status: 'installed',
      },
      runtime_manager: defaultRuntimeManager(),
      message: 'enabled',
    })),
    getModelCapabilities: jest.fn(() => of({
      generated_at: '1',
      checked_at: '1',
      status: 'ready',
      capabilities: [
        {
          capability_id: 'semantic_router',
          label: 'Question understanding',
          model_kind: 'llm',
          status: 'ready',
          current_model: {
            model_endpoint_id: 'llm-local',
            model_name: '/models/chat.gguf',
            provider_key: 'local',
            status: 'active',
          },
          installable_models: [],
          download_jobs: [],
          next_action: '可以使用',
          runtime_ready: true,
        },
        {
          capability_id: 'embedder',
          label: 'Vector search',
          model_kind: 'embedder',
          status: 'ready',
          current_model: {
            model_endpoint_id: 'embedder-local',
            model_name: '/models/embed.gguf',
            provider_key: 'local',
            status: 'active',
          },
          installable_models: [],
          download_jobs: [],
          next_action: '可以使用',
          runtime_ready: true,
        },
        {
          capability_id: 'retrieval_answer',
          label: 'Conversation answer',
          model_kind: 'llm',
          status: 'ready',
          current_model: {
            model_endpoint_id: 'llm-local',
            model_name: '/models/chat.gguf',
            provider_key: 'local',
            status: 'active',
          },
          installable_models: [],
          download_jobs: [],
          next_action: '可以使用',
          runtime_ready: true,
        },
        {
          capability_id: 'vlm',
          label: 'Image/video understanding',
          model_kind: 'vlm',
          status: 'needs_model',
          current_model: null,
          installable_models: [],
          download_jobs: [],
          next_action: '选择或安装模型',
          runtime_ready: false,
        },
      ],
      blockers: [],
      warnings: [],
    })),
    getModelPolicies: jest.fn(() => of({
      route_policies: [
        modelPolicy('semantic.router', 'allow_redacted_cloud', ['local', 'sidecar', 'cloud']),
        modelPolicy('retrieval.answer', 'allow_redacted_cloud', ['local', 'sidecar', 'cloud']),
      ],
    })),
    saveModelPolicies: jest.fn((payload) => of(payload)),
    getLocalModelCatalog: jest.fn(() => of({
      models: [
        {
          model_id: 'harbor-embed-small',
          display_name: 'Harbor Embed Small',
          provider_key: 'local',
          model_kind: 'embedding',
          status: 'installed',
          installed: true,
          local_path: '/models/embed.gguf',
          expected_capabilities: ['embedding'],
          recommended_hardware: 'CPU',
          download_size_hint: '1 GiB',
        },
        {
          model_id: 'harbor-vision-small',
          display_name: 'Harbor Vision Small',
          provider_key: 'local',
          model_kind: 'vlm',
          status: 'available',
          expected_capabilities: ['vision', 'video'],
          recommended_hardware: 'GPU',
          download_size_hint: '4 GiB',
        },
      ],
      download_jobs: [],
    })),
    getLocalModelDownloads: jest.fn(() => of({ jobs: [] })),
    getHardwareReadiness: jest.fn(() => of({
      status: 'ready',
      cpu: statusComponent,
      memory: statusComponent,
      gpu: statusComponent,
      npu: statusComponent,
      recommended_model_profile: 'cpu',
    })),
    getRagReadiness: jest.fn(() => of({
      status: 'ready',
      source_roots: statusComponent,
      index_directory: statusComponent,
      embedding_model: statusComponent,
      media_parser: statusComponent,
      storage_writable: statusComponent,
      capability_profiles: [],
      blockers: [],
      warnings: [],
    })),
    getKnowledgeSettings: jest.fn(() => of({
      source_roots: [
        { root_id: 'nas', label: 'NAS Library', path: '/mnt/pool/library', enabled: true, include: [], exclude: [] },
      ],
      index_root: '/var/lib/harbor/index',
      privacy_level: 'strict_local',
      default_resource_profile: 'cpu_only',
    })),
    getKnowledgeIndexStatus: jest.fn(() => of({
      status: 'ready',
      index_root_writable: true,
      source_roots: [
        { root_id: 'nas', path: '/mnt/pool/library', enabled: true, exists: true, status: 'ready' },
      ],
      image_count: 1,
      content_indexed_image_count: 1,
      vlm_indexed_image_count: 1,
      image_content_missing_count: 0,
      blockers: [],
    })),
    saveKnowledgeSettings: jest.fn((payload) => of(payload)),
    runKnowledgeIndex: jest.fn(() => of({ status: 'started' })),
    createLocalModelDownload: jest.fn((payload) => of({ job: { job_id: 'job-1', model_id: payload.model_id, status: 'queued' } })),
    cancelLocalModelDownload: jest.fn(() => of({ status: 'canceled' })),
    getDvrRecordingSettings: jest.fn(() => of({ enabled_device_ids: [] })),
    getDvrRecordingStatus: jest.fn(() => of({ statuses: [] })),
    getDvrTimeline: jest.fn(() => of({ segments: [] })),
    getHarborOsStatus: jest.fn(() => of({
      status: 'ready',
      version: '26.04',
      webui_url: 'https://192.168.3.21/ui',
      system_domain_only: true,
      services: [],
      jobs_alerts: harborOsService('jobs-alerts'),
      storage_files_entry: harborOsService('storage-files-entry'),
      blockers: [],
    })),
    getHarborOsImCapabilityMap: jest.fn(() => of({ items: [] })),
    getHomeAssistantStatus: jest.fn(() => of({
      configured: false,
      enabled: true,
      base_url: '',
      token_configured: false,
      token_redacted: false,
      exposed_domains: ['light', 'switch', 'sensor', 'camera'],
      status: 'not_configured',
      entity_count: 0,
      service_count: 0,
    })),
    saveHomeAssistantConfig: jest.fn((payload) => of({
      status: {
        configured: Boolean(payload.base_url),
        enabled: payload.enabled,
        base_url: payload.base_url,
        token_configured: Boolean(payload.access_token),
        token_redacted: Boolean(payload.access_token),
        exposed_domains: payload.exposed_domains,
        status: payload.base_url ? 'configured' : 'not_configured',
        entity_count: 0,
        service_count: 0,
      },
    })),
    testHomeAssistantConnection: jest.fn(() => of({
      test: { ok: true, status: 'connected', location_name: 'Home', version: '2026.5.0' },
      status: {
        configured: true,
        enabled: true,
        base_url: 'http://homeassistant.local:8123',
        token_configured: true,
        token_redacted: true,
        exposed_domains: ['light', 'camera'],
        status: 'connected',
        entity_count: 0,
        service_count: 0,
        location_name: 'Home',
        version: '2026.5.0',
      },
    })),
    syncHomeAssistant: jest.fn(() => of({
      status: {
        configured: true,
        enabled: true,
        base_url: 'http://homeassistant.local:8123',
        token_configured: true,
        token_redacted: true,
        exposed_domains: ['light', 'camera'],
        status: 'synced',
        entity_count: 1,
        service_count: 1,
      },
      entities: [{ entity_id: 'light.kitchen', domain: 'light', state: 'on', display_name: 'Kitchen' }],
      service_domains: [{ domain: 'light', services: [{ service: 'turn_on' }] }],
    })),
    getHomeAssistantEntities: jest.fn(() => of({
      entities: [{ entity_id: 'light.kitchen', domain: 'light', state: 'on', display_name: 'Kitchen' }],
    })),
    getHomeAssistantServices: jest.fn(() => of({
      services: [{ domain: 'light', services: [{ service: 'turn_on' }] }],
    })),
    getHomeAssistantInstallStatus: jest.fn(() => of({
      app_id: 'home-assistant',
      status: 'not_installed',
      managed: true,
      runtime: 'docker_container',
      container_name: 'harbor-home-assistant',
      onboarding_url: null,
      message: 'Home Assistant Container is not installed yet.',
    })),
    getHomeAssistantInstallPlan: jest.fn(() => of({
      app_id: 'home-assistant',
      target: 'Home Assistant Container',
      runtime: 'docker',
      image: 'ghcr.io/home-assistant/home-assistant:stable',
      container_name: 'harbor-home-assistant',
      ports: ['8123:8123/tcp'],
      volumes: ['harbor-home-assistant-config:/config'],
      next_step: 'Create the container.',
    })),
    installHomeAssistant: jest.fn(() => of({
      status: 'created',
      dry_run: false,
      message: 'Home Assistant install requested.',
      plan: {
        app_id: 'home-assistant',
        target: 'Home Assistant Container',
        runtime: 'docker',
        image: 'ghcr.io/home-assistant/home-assistant:stable',
        container_name: 'harbor-home-assistant',
        ports: ['8123:8123/tcp'],
        volumes: ['harbor-home-assistant-config:/config'],
        next_step: 'Create the container.',
      },
    })),
    getShareLinks: jest.fn(() => of([])),
    getLocalVisionEvents: jest.fn(() => of({ generated_at: 'epoch_ms:0', limit: 5, events: [] })),
    getVisionVlmStatus: jest.fn(() => of({
      generated_at: 'epoch_ms:0',
      kind: 'vision_vlm_status_v1',
      readiness: { status: 'available', endpoint_ready: true },
      latest_enrichment: { status: 'not_run' },
      metadata_only: true,
      secret_scan: 'clean',
    })),
    enrichVisionEventWithVlm: jest.fn((eventId) => of({
      status: 'active',
      reason: 'enriched',
      event: storedLocalVisionEvent(eventId),
      metadata_only: true,
      secret_scan: 'clean',
    })),
    enrichLatestVisionEventWithVlm: jest.fn(() => of({
      status: 'busy',
      reason: 'queue_busy',
      metadata_only: true,
      secret_scan: 'clean',
    })),
    getFamilyTimeline: jest.fn(() => of({
      generated_at: 'epoch_ms:0',
      window_seconds: 86400,
      event_count: 0,
      metadata_only: true,
      buckets: [],
      events: [],
    })),
    getFamilyTimelineDigest: jest.fn(() => of({
      generated_at: 'epoch_ms:0',
      status: 'quiet',
      window_seconds: 86400,
      event_count: 0,
      headline: 'No family timeline digest yet.',
      bullets: [],
      top_labels: [],
      cameras: [],
      latest_event_id: null,
      metadata_only: true,
      secret_scan: 'clean',
    })),
    getFamilyMemoryEvents: jest.fn(() => of({
      generated_at: 'epoch_ms:0',
      limit: 50,
      metadata_only: true,
      secret_scan: 'clean',
      memory_overlay: familyMemoryStats(),
      events: [],
    })),
    getFamilyMemoryStats: jest.fn(() => of(familyMemoryStats())),
    submitFamilyMemoryFeedback: jest.fn(() => of({
      status: 'stored',
      event_id: 'lve_guardian_1',
      feedback: {},
      memory_overlay: familyMemoryStats({ favorite_count: 1 }),
      evidence: {},
      metadata_only: true,
      secret_scan: 'clean',
    })),
    getRoutingStatus: jest.fn(() => of({
      kind: 'harborbeacon.routing_status.v1',
      generated_at: 'epoch_ms:0',
      metadata_only: true,
      scope: 'beacon_internal_orchestration',
      execution_routes: [],
      model_route_policies: [],
      capability_readiness: [],
      runtimes: [],
      boundaries: [],
      fallback_blockers: [],
      secret_scan: 'clean',
    })),
    getAuditRecords: jest.fn(() => of({
      records: [],
      total: 0,
      limit: 12,
      next_cursor: null,
      metadata_only: true,
      secret_scan: 'clean',
    })),
    getAuditSummary: jest.fn(() => of({
      total: 0,
      window: '24h',
      by_entity_kind: {},
      by_action: {},
      by_actor_kind: {},
      metadata_only: true,
      secret_scan: 'clean',
    })),
    getHomeGuardianActivity: jest.fn(() => of({
      generated_at: 'epoch_ms:0',
      rule_count: 0,
      active_count: 0,
      rules: [],
      activity: [],
      counters: {},
      metadata_only: true,
      secret_scan: 'clean',
    })),
    evaluateAutomationReviewLatest: jest.fn(() => of({
      evaluation_id: 'guardian_eval_0',
      status: 'evaluated',
      event_id: '',
      evaluated_at: 'epoch_ms:0',
      results: [],
      counters: {},
      metadata_only: true,
      secret_scan: 'clean',
    })),
    getEvtReadiness: jest.fn(() => of({
      status: 'ready',
      profile: 'k3-direct-72h-readiness',
      generated_at: '1710000000',
      blockers: [],
      warnings: [],
      services: [{ service: 'harboros-beacon.service', status: 'active', active: true }],
      gateway: { status: 'available', default_target_ready: true },
      home_assistant: { status: 'synced', entity_count: 3 },
      camera: { status: 'available', configured_count: 2, latest_event_available: true },
      models: { semantic_router: { status: 'active', local_only: true } },
      resources: {
        memory: { status: 'available', available_percent: 42 },
        disk: { root: { status: 'available', use_percent: 20 } },
        thermal: { status: 'available', max_celsius: 52 },
      },
      security: { secret_scan: { status: 'clean', total_count: 0, counts: { rtsp_url: 0, bearer_token: 0 } } },
      redacted: true,
    })),
    runEvtPreflight: jest.fn(() => of({
      status: 'ready',
      completed_at: '1710000001',
      duration_ms: 88,
      long_run_started: false,
      short_run_started: false,
      readiness: {
        status: 'ready',
        profile: 'k3-direct-72h-readiness',
        blockers: [],
        warnings: [],
      },
      redacted: true,
    })),
    getEvtPreflightLatest: jest.fn(() => of({
      status: 'not_run',
      long_run_started: false,
      short_run_started: false,
      redacted: true,
    })),
    getEvtEvidenceBundle: jest.fn(() => of({
      status: 'ready',
      generated_at: '1710000002',
      readiness: {
        status: 'ready',
        profile: 'k3-direct-72h-readiness',
        blockers: [],
        warnings: [],
      },
      preflight: {
        kind: 'evt_preflight_v1',
        status: 'ready',
        long_run_started: false,
        short_run_started: false,
      },
      redacted: true,
    })),
  };
}

function modelCapabilitiesWithEmbedder(embedderOverrides: Record<string, unknown>): unknown {
  const llmCurrentModel = {
    model_endpoint_id: 'llm-local',
    model_name: '/models/chat.gguf',
    provider_key: 'local',
    status: 'active',
  };
  const embedder = {
    capability_id: 'embedder',
    label: 'Vector search',
    model_kind: 'embedder',
    status: 'ready',
    current_model: {
      model_endpoint_id: 'embedder-local',
      model_name: '/models/embed.gguf',
      provider_key: 'local',
      status: 'active',
    },
    installed_models: [],
    installable_models: [],
    download_jobs: [],
    next_action: '可以使用',
    runtime_ready: true,
    ...embedderOverrides,
  };
  return {
    generated_at: '1',
    checked_at: '1',
    status: 'ready',
    capabilities: [
      {
        capability_id: 'semantic_router',
        label: 'Question understanding',
        model_kind: 'llm',
        status: 'ready',
        current_model: llmCurrentModel,
        installable_models: [],
        download_jobs: [],
        next_action: '可以使用',
        runtime_ready: true,
      },
      embedder,
      {
        capability_id: 'retrieval_answer',
        label: 'Conversation answer',
        model_kind: 'llm',
        status: 'ready',
        current_model: llmCurrentModel,
        installable_models: [],
        download_jobs: [],
        next_action: '可以使用',
        runtime_ready: true,
      },
      {
        capability_id: 'vlm',
        label: 'Image/video understanding',
        model_kind: 'vlm',
        status: 'needs_model',
        current_model: null,
        installable_models: [],
        download_jobs: [],
        next_action: '选择或安装模型',
        runtime_ready: false,
      },
    ],
    blockers: [],
    warnings: [],
  };
}

function defaultRuntimeManager(): {
  generated_at: string;
  checked_at: string;
  status: string;
  runtimes: Array<Record<string, unknown>>;
  blockers: string[];
  warnings: string[];
} {
  return {
    generated_at: '1',
    checked_at: '1',
    status: 'ready',
    runtimes: [
      {
        runtime_id: 'harbor-candle',
        display_name: 'Harbor Candle Runtime',
        runtime_kind: 'embedded_candle',
        provider_key: 'harbor',
        status: 'active',
        managed: true,
        installable: true,
        enabled: true,
        capabilities: ['llm', 'embedding'],
        runtime_profiles: ['harbor-candle', 'harbor-model-api-candle'],
        model_store_path: '/mnt/software/harborbeacon-agent-ci/model-store/runtimes/harbor-candle',
        message: 'Runtime 已安装，并正在服务 Harbor-managed 推理路径。',
        installed: true,
        active: true,
        next_action: '可以使用',
      },
      {
        runtime_id: 'harbor-vlm-sidecar',
        display_name: 'Harbor Vision Runtime',
        runtime_kind: 'managed_sidecar',
        provider_key: 'harbor',
        status: 'not_available',
        managed: true,
        installable: false,
        enabled: false,
        capabilities: ['vlm'],
        runtime_profiles: ['harbor-vlm-sidecar'],
        model_store_path: '/mnt/software/harborbeacon-agent-ci/model-store/runtimes/harbor-vlm-sidecar',
        message: 'Harbor Vision Runtime is reserved for managed VLM packages.',
        installed: false,
        active: false,
        next_action: '当前 ISO 未包含该 runtime 包，可在高级设置接入 OpenAI-compatible endpoint',
      },
    ],
    blockers: [],
    warnings: [],
  };
}

function qwenCatalogModel(overrides: Record<string, unknown> = {}): unknown {
  return {
    model_id: 'Qwen/Qwen3.5-4B',
    display_name: 'Qwen3.5 4B',
    provider_key: 'qwen',
    model_kind: 'embedder',
    source_kind: 'huggingface',
    status: 'needs-config',
    installable: true,
    manual_only: false,
    repo_id: 'Qwen/Qwen3.5-4B',
    revision: 'main',
    file_policy: 'runtime_snapshot',
    expected_capabilities: ['embedder'],
    recommended_hardware: 'GPU',
    download_size_hint: '4 GiB',
    ...overrides,
  };
}

function modelEndpoint(id: string, kind: string, modelName: string): unknown {
  return {
    model_endpoint_id: id,
    workspace_id: null,
    provider_account_id: null,
    model_kind: kind,
    endpoint_kind: 'local',
    provider_key: 'local',
    model_name: modelName,
    capability_tags: [kind],
    cost_policy: {},
    status: 'active',
    metadata: { local_path: modelName },
  };
}

function modelPolicy(routePolicyId: string, privacyLevel: string, fallbackOrder: string[]): unknown {
  return {
    route_policy_id: routePolicyId,
    workspace_id: 'home-1',
    domain_scope: routePolicyId === 'semantic.router' ? 'semantic' : 'retrieval',
    modality: 'text',
    privacy_level: privacyLevel,
    local_preferred: true,
    max_cost_per_run: null,
    fallback_order: fallbackOrder,
    status: 'active',
    metadata: {},
  };
}

function harborOsService(id: string): unknown {
  return {
    service_id: id,
    label: id,
    status: 'ready',
    detail: 'ready',
  };
}

function routerSelectionCapabilities(overrides: Record<string, unknown> = {}): object {
  const response = modelCapabilitiesWithEmbedder({});
  return {
    ...response,
    capabilities: response.capabilities.map((capability) => {
      if (capability.capability_id !== 'semantic_router') {
        return capability;
      }
      return {
        ...capability,
        desired_model_id: 'harbor-qwen38-27b',
        selected_model_id: 'harbor-qwen38-27b',
        active_model_id: 'harbor-qwen38-27b',
        transition_status: 'ready',
        last_error: null,
        current_model: {
          model_endpoint_id: 'llm-27b',
          model_name: 'harbor-qwen38-27b',
          provider_key: 'local',
          status: 'active',
        },
        installed_models: [{
          model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
          display_name: 'Qwen2.5 0.5B',
          provider_key: 'qwen',
          model_kind: 'llm',
          status: 'ready',
          installed: true,
          local_path: '/models/qwen05',
        }, {
          model_id: 'harbor-qwen38-27b',
          display_name: 'Qwen3.8 27B',
          provider_key: 'local',
          model_kind: 'llm',
          status: 'ready',
          installed: true,
          local_path: '/models/qwen27',
        }],
        ...overrides,
      };
    }),
  };
}
