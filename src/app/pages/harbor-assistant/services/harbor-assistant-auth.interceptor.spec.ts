import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, retry, throwError } from 'rxjs';
import { AuthService } from 'app/modules/auth/auth.service';
import * as prefix from 'app/pages/harbor-assistant/services/harbor-assistant-api-prefix';
import { harborAssistantAuthInterceptor } from 'app/pages/harbor-assistant/services/harbor-assistant-auth.interceptor';

describe('Harbor Assistant one-time authentication', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let token: jest.Mock;

  beforeEach(() => {
    token = jest.fn(() => of(`token-${token.mock.calls.length}`));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([harborAssistantAuthInterceptor])), provideHttpClientTesting(),
        { provide: AuthService, useValue: { getHarborAssistantOneTimeToken: token } },
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    jest.restoreAllMocks();
  });

  it('mints a fresh user token for each request and each retry', async () => {
    const result = firstValueFrom(http.get('/api/harbor-beacon/models/capabilities').pipe(retry(1)));
    const first = controller.expectOne('/api/harbor-beacon/models/capabilities');
    expect(first.request.headers.get('X-HarborOS-Auth-Token')).toBe('token-1');
    expect(first.request.headers.has('Authorization')).toBe(false);
    first.flush({}, { status: 500, statusText: 'Temporary error' });
    const second = controller.expectOne('/api/harbor-beacon/models/capabilities');
    expect(second.request.headers.get('X-HarborOS-Auth-Token')).toBe('token-2');
    second.flush({ capabilities: [] });
    await expect(result).resolves.toEqual({ capabilities: [] });
    expect(token).toHaveBeenCalledTimes(2);
  });

  it('preserves the single-use token owned by an authenticated content request', async () => {
    const result = firstValueFrom(http.post('/api/harbor-gate/api/beacon/knowledge/search', {}, {
      headers: { 'X-HarborOS-Auth-Token': 'owned-token' },
    }));
    const request = controller.expectOne('/api/harbor-gate/api/beacon/knowledge/search');
    expect(request.request.headers.get('X-HarborOS-Auth-Token')).toBe('owned-token');
    expect(token).not.toHaveBeenCalled();
    request.flush({});
    await result;
  });

  it.each(['/assets/i18n/en.json', 'https://remote.example/api/harbor-beacon/state'])('does not attach NAS credentials to %s', async (url) => {
    const result = firstValueFrom(http.get(url));
    const request = controller.expectOne(url);
    expect(request.request.headers.has('X-HarborOS-Auth-Token')).toBe(false);
    expect(token).not.toHaveBeenCalled();
    request.flush({});
    await result;
  });

  it('retains the HarborNavi profile authentication boundary', async () => {
    jest.spyOn(prefix, 'harborAssistantGateRequiresUserToken').mockReturnValue(false);
    const result = firstValueFrom(http.get('/api/harbor-beacon/state'));
    const request = controller.expectOne('/api/harbor-beacon/state');
    expect(token).not.toHaveBeenCalled();
    request.flush({});
    await result;
  });

  it('fails closed when middleware cannot issue user proof', async () => {
    token.mockReturnValue(throwError(() => new Error('Login expired')));
    await expect(firstValueFrom(http.get('/api/harbor-beacon/state'))).rejects.toThrow('Login expired');
    controller.expectNone('/api/harbor-beacon/state');
  });
});
