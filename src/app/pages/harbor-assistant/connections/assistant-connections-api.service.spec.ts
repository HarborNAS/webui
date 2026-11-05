import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { AuthService } from 'app/modules/auth/auth.service';
import { AssistantConnectionsApiService } from 'app/pages/harbor-assistant/connections/assistant-connections-api.service';
import { harborAssistantAuthInterceptor } from 'app/pages/harbor-assistant/services/harbor-assistant-auth.interceptor';

describe('Native identity pairing API', () => {
  let api: AssistantConnectionsApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([harborAssistantAuthInterceptor])), provideHttpClientTesting(),
        { provide: AuthService, useValue: { getHarborAssistantOneTimeToken: () => of('single-use-identity') } },
      ],
    });
    api = TestBed.inject(AssistantConnectionsApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('creates the challenge for the authenticated caller with an empty body', async () => {
    const result = firstValueFrom(api.createFeishuIdentityChallenge());
    const request = http.expectOne('/api/harbor-gate/api/beacon/im/feishu/identity-challenges');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({});
    expect(request.request.headers.get('X-HarborOS-Auth-Token')).toBe('single-use-identity');
    request.flush({
      challenge_id: 'opaque',
      challenge_text: 'HARBOR-BIND SYNTHETIC',
      status: 'pending',
      expires_at: '2026-11-05T04:00:00Z',
    });
    await expect(result).resolves.toMatchObject({ status: 'pending' });
  });

  it('checks only the opaque owned challenge ID with fresh user proof', async () => {
    const result = firstValueFrom(api.feishuIdentityChallengeStatus('owned/challenge'));
    const request = http.expectOne('/api/harbor-gate/api/beacon/im/feishu/identity-challenges/owned%2Fchallenge');
    expect(request.request.method).toBe('GET');
    expect(request.request.headers.get('X-HarborOS-Auth-Token')).toBe('single-use-identity');
    request.flush({ challenge_id: 'owned/challenge', status: 'bound', expires_at: '2026-11-05T04:00:00Z' });
    await expect(result).resolves.toMatchObject({ status: 'bound' });
  });
});
