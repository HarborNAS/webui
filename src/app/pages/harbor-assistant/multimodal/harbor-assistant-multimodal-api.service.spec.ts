import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { createServiceFactory, SpectatorService } from '@ngneat/spectator/jest';
import { firstValueFrom } from 'rxjs';
import { HarborAssistantMultimodalApiService } from 'app/pages/harbor-assistant/multimodal/harbor-assistant-multimodal-api.service';

describe('HarborAssistantMultimodalApiService', () => {
  let spectator: SpectatorService<HarborAssistantMultimodalApiService>;
  let http: HttpTestingController;
  const createService = createServiceFactory({
    service: HarborAssistantMultimodalApiService,
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });

  beforeEach(() => {
    spectator = createService();
    http = spectator.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('uses Automatic policy routing and image content through the Beacon inference facade', async () => {
    const answer = firstValueFrom(spectator.service.describeImage('data:image/png;base64,AAAA', 'Describe the device'));
    const request = http.expectOne('/api/harbor-beacon/inference/v1/vision/chat/completions');
    expect(request.request.body).toEqual({
      model: 'automatic',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze the attached image using only visible evidence. If it is an application screen, identify the visible page and its main purpose before answering. For each visible object, report its own shape and color independently; do not transfer attributes between objects or infer a shared color. Then answer the user request concisely and include the requested visible details. Do not invent unreadable text, hidden state, or facts that are not visible. User request: Describe the device' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      }],
      stream: false,
      temperature: 0,
      max_tokens: 192,
    });
    request.flush({ choices: [{ message: { content: 'A storage device.' } }] });
    expect(request.request.body.messages[0].content[0].text).toContain('report its own shape and color independently');
    expect(request.request.body.messages[0].content[0].text).toContain('do not transfer attributes between objects');
    expect(request.request.body.messages[0].content[0].text).toContain('main purpose before answering');
    expect(request.request.body.messages[0].content[0].text).toContain('User request: Describe the device');
    expect((await answer).choices?.[0].message?.content).toBe('A storage device.');
  });

  it('uploads the real audio file and language as multipart form data', async () => {
    const file = new File(['wave'], 'sample.wav', { type: 'audio/wav' });
    const result = firstValueFrom(spectator.service.transcribe(file, 'zh'));
    const request = http.expectOne('/api/harbor-beacon/inference/v1/audio/transcriptions');
    const body = request.request.body as FormData;
    expect(body.get('file')).toEqual(file);
    expect(body.get('language')).toBe('zh');
    expect(request.request.headers.has('Content-Type')).toBe(false);
    request.flush({ text: '你好' });
    expect((await result).text).toBe('你好');
  });

  it('requests WAV bytes and omits a voice when Automatic is selected', async () => {
    const result = firstValueFrom(spectator.service.speak('你好', ''));
    const request = http.expectOne('/api/harbor-beacon/inference/v1/audio/speech');
    expect(request.request.body).toEqual({ input: '你好', response_format: 'wav' });
    expect(request.request.responseType).toBe('blob');
    request.flush(new Blob(['wave'], { type: 'audio/wav' }));
    expect((await result).type).toBe('audio/wav');
  });
});
