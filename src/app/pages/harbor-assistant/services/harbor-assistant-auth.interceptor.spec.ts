import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, retry, throwError } from 'rxjs';
import { mockWindow } from 'app/core/testing/utils/mock-window.utils';
import { ApiService } from 'app/modules/websocket/api.service';
import { harborAssistantAuthInterceptor } from 'app/pages/harbor-assistant/services/harbor-assistant-auth.interceptor';

describe('harborAssistantAuthInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  const call = jest.fn();

  beforeEach(() => {
    call.mockReset();
    call.mockReturnValue(of('user-single-use-token'));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([harborAssistantAuthInterceptor])),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: { call } },
        mockWindow({ location: { href: 'https://harbor.test/ui/' } }),
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('exchanges a separate single-use user token for a Beacon request', async () => {
    const result = firstValueFrom(http.post('/api/harbor-beacon/knowledge/search', { query: 'demo' }));
    const request = httpMock.expectOne('/api/harbor-beacon/knowledge/search');
    expect(call).toHaveBeenCalledWith('auth.generate_token', [60, {}, false, true]);
    expect(request.request.headers.get('Authorization')).toBe('Bearer user-single-use-token');
    expect(request.request.body).toEqual({ query: 'demo' });
    request.flush({ conversation_id: 'demo-1' });
    await expect(result).resolves.toEqual({ conversation_id: 'demo-1' });
  });

  it.each([
    '/api/harbor-llama/v1/chat/completions',
    '/api/harbor-beacon-elsewhere/state',
    '/api/boot_id',
    'https://external.test/api/harbor-beacon/knowledge/search',
    '//external.test/api/harbor-beacon/state',
  ])('does not attach credentials to %s', async (url) => {
    const result = firstValueFrom(http.get(url));
    const request = httpMock.expectOne(url);
    expect(request.request.headers.has('Authorization')).toBe(false);
    expect(call).not.toHaveBeenCalled();
    request.flush({});
    await result;
  });

  it('does not fall back to an anonymous request when token generation fails', async () => {
    const error = new Error('Session expired');
    call.mockReturnValue(throwError(() => error));
    await expect(firstValueFrom(http.get('/api/harbor-beacon/state'))).rejects.toBe(error);
    httpMock.expectNone('/api/harbor-beacon/state');
  });

  it('generates another token when the caller retries a failed Beacon request', async () => {
    call.mockReturnValueOnce(of('first-token')).mockReturnValueOnce(of('second-token'));
    const result = firstValueFrom(http.get('/api/harbor-beacon/state').pipe(retry(1)));
    const first = httpMock.expectOne('/api/harbor-beacon/state');
    expect(first.request.headers.get('Authorization')).toBe('Bearer first-token');
    first.flush({}, { status: 503, statusText: 'Unavailable' });
    const second = httpMock.expectOne('/api/harbor-beacon/state');
    expect(second.request.headers.get('Authorization')).toBe('Bearer second-token');
    second.flush({ ready: true });
    await expect(result).resolves.toEqual({ ready: true });
    expect(call).toHaveBeenCalledTimes(2);
  });
});
