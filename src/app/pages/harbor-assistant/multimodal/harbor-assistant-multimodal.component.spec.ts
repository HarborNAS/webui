import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { HttpErrorResponse } from '@angular/common/http';
import { MatButtonHarness } from '@angular/material/button/testing';
import { createComponentFactory, mockProvider, Spectator } from '@ngneat/spectator/jest';
import { of, Subject, throwError } from 'rxjs';
import { AssistantSessionStore } from 'app/pages/harbor-assistant/composer/assistant-session.store';
import { ModelEndpointRecord, ModelRoutePolicyRecord } from 'app/pages/harbor-assistant/interfaces/harbor-assistant-status.interface';
import { HarborAssistantMultimodalApiService } from 'app/pages/harbor-assistant/multimodal/harbor-assistant-multimodal-api.service';
import { HarborAssistantMultimodalComponent } from 'app/pages/harbor-assistant/multimodal/harbor-assistant-multimodal.component';

interface MultimodalTestAccess {
  question: { set: (value: string) => void };
  speechText: { set: (value: string) => void };
}

describe('HarborAssistantMultimodalComponent', () => {
  let spectator: Spectator<HarborAssistantMultimodalComponent>;
  const api = {
    describeImage: jest.fn(),
    transcribe: jest.fn(() => of({ text: '真实的转写' })),
    speak: jest.fn(() => of(new Blob(['wave'], { type: 'audio/wav' }))),
  };
  const updateDraft = jest.fn();
  const createComponent = createComponentFactory({
    component: HarborAssistantMultimodalComponent,
    providers: [
      { provide: HarborAssistantMultimodalApiService, useValue: api },
      mockProvider(AssistantSessionStore, {
        draft: () => ({ text: 'Existing question' }),
        updateDraft,
      }),
    ],
  });

  const originalUrl = globalThis.URL;
  beforeEach(() => {
    jest.clearAllMocks();
    const mockUrl = class extends originalUrl {};
    Object.defineProperties(mockUrl, {
      createObjectURL: { value: jest.fn(() => 'blob:test-audio') },
      revokeObjectURL: { value: jest.fn() },
    });
    Object.defineProperty(globalThis, 'URL', { configurable: true, value: mockUrl });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'URL', { configurable: true, value: originalUrl });
  });

  function selectFile(selector: string, file: File): void {
    const element = spectator.query<HTMLInputElement>(selector);
    expect(element).not.toBeNull();
    Object.defineProperty(element, 'files', { value: [file], configurable: true });
    spectator.dispatchFakeEvent(element as HTMLInputElement, 'change');
  }

  async function button(text: string): Promise<MatButtonHarness> {
    return TestbedHarnessEnvironment.loader(spectator.fixture).getHarness(MatButtonHarness.with({ text }));
  }

  it('labels direct upload VLM separately from indexed image search', () => {
    spectator = createComponent();
    expect(spectator.element.textContent).toContain('Direct image understanding');
    expect(spectator.element.textContent).toContain('does not search indexed sources or create citations');
  });

  it('shows true missing runtime blockers without declaring multimodal ready', () => {
    spectator = createComponent();
    expect(spectator.queryAll('.multimodal-status .blocker')).toHaveLength(3);
    expect(spectator.element.textContent).toContain('TTS');
    spectator.setInput('endpointsLoading', true);
    expect(spectator.element.textContent).toContain('Loading endpoint status');
    expect(spectator.queryAll('.multimodal-status .blocker')).toHaveLength(0);
  });

  it('shows readonly endpoint metadata including TTS runtime', () => {
    spectator = createComponent({
      props: {
        endpoints: [{
          model_kind: 'tts',
          status: 'active',
          model_name: 'piper',
          metadata: {
            runtime_backend_kind: 'piper', runtime_device: 'CPU', persistent: true,
          },
        } as ModelEndpointRecord],
      },
    });
    expect(spectator.element.textContent).toContain('active · piper');
    expect(spectator.element.textContent).toContain('Persistent: true');
    expect(spectator.queryAll('.multimodal-status .blocker')).toHaveLength(2);
  });

  it('shows the active ASR policy pin instead of an earlier active CPU fallback', () => {
    const cpu = {
      model_endpoint_id: 'asr-local', model_kind: 'asr', status: 'active', model_name: 'CPU fallback',
    } as ModelEndpointRecord;
    const igpu = {
      model_endpoint_id: 'asr-local-whisper-igpu', model_kind: 'asr', status: 'active', model_name: '780M ASR',
    } as ModelEndpointRecord;
    const policy = { route_policy_id: 'retrieval.asr', status: 'active', metadata: { model_endpoint_id: igpu.model_endpoint_id } } as ModelRoutePolicyRecord;
    spectator = createComponent({ props: { endpoints: [cpu, igpu], routePolicies: [policy] } });
    expect(spectator.element.textContent).toContain('780M ASR');
    expect(spectator.element.textContent).not.toContain('CPU fallback');
    spectator.setInput('routePolicies', [{ ...policy, metadata: { model_endpoint_id: 'missing' } }]);
    expect(spectator.queryAll('.multimodal-status .blocker')).toHaveLength(3);
    expect(spectator.element.textContent).not.toContain('CPU fallback');
  });

  it('rejects invalid or oversized image and audio files before any endpoint request', () => {
    spectator = createComponent();
    selectFile('input[accept="image/png,image/jpeg,image/webp"]', new File(['svg'], 'x.svg', {
      type: 'image/svg+xml',
    }));
    selectFile('input[accept^=".wav"]', new File(['text'], 'x.txt', { type: 'text/plain' }));
    expect(spectator.element.textContent).toContain('Choose a PNG, JPEG or WebP');
    expect(spectator.element.textContent).toContain('Choose a WAV');
    const largeFile = new File(['image'], 'large.png', { type: 'image/png' });
    Object.defineProperty(largeFile, 'size', { value: 10 * 1024 * 1024 + 1 });
    selectFile('input[accept="image/png,image/jpeg,image/webp"]', largeFile);
    expect(spectator.element.textContent).toContain('up to 10 MiB');
    expect(api.describeImage).not.toHaveBeenCalled();
    expect(api.transcribe).not.toHaveBeenCalled();
  });

  it('keeps a real transcript local until the user explicitly adds it to the conversation draft', async () => {
    spectator = createComponent();
    selectFile('input[accept^=".wav"]', new File(['wave'], 'sample.wav', { type: 'audio/wav' }));
    await (await button('Transcribe audio')).click();
    expect(spectator.element.textContent).toContain('真实的转写');
    expect(updateDraft).not.toHaveBeenCalled();
    await (await button('Add transcript to conversation draft')).click();
    expect(updateDraft).toHaveBeenCalledWith({ text: 'Existing question\n真实的转写' });
  });

  it('plays actual WAV output and revokes generated media URLs on destroy', async () => {
    spectator = createComponent();
    (spectator.component as unknown as MultimodalTestAccess).speechText.set('Hello');
    spectator.detectChanges();
    await (await button('Generate speech')).click();
    expect(api.speak).toHaveBeenCalledWith('Hello', '');
    expect(spectator.query('audio')?.getAttribute('src')).toBe('blob:test-audio');
    spectator.fixture.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-audio');
  });

  it('shows the endpoint blocker instead of fabricating speech output', async () => {
    api.speak.mockReturnValueOnce(throwError(() => new HttpErrorResponse({
      status: 503, error: { error: { message: 'needs_runtime: TTS is not configured' } },
    })));
    spectator = createComponent();
    (spectator.component as unknown as MultimodalTestAccess).speechText.set('Hello');
    spectator.detectChanges();
    await (await button('Generate speech')).click();
    expect(spectator.element.textContent).toContain('needs_runtime: TTS is not configured');
    expect(spectator.query('audio')).not.toExist();
  });

  it('retains loading while real speech generation is pending and prevents duplicate requests', async () => {
    const pending$ = new Subject<Blob>();
    api.speak.mockReturnValueOnce(pending$);
    spectator = createComponent();
    (spectator.component as unknown as MultimodalTestAccess).speechText.set('Hello');
    spectator.detectChanges();
    await (await button('Generate speech')).click();
    expect(await (await button('Generating speech…')).isDisabled()).toBe(true);
    expect(api.speak).toHaveBeenCalledTimes(1);
    pending$.complete();
  });
});
