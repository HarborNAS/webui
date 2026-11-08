import 'jest-canvas-mock';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { fakeAsync, tick } from '@angular/core/testing';
import { MatButtonHarness } from '@angular/material/button/testing';
import { MatInputHarness } from '@angular/material/input/testing';
import { createComponentFactory, Spectator } from '@ngneat/spectator/jest';
import { of, throwError } from 'rxjs';
import { AssistantConnectionsApiService } from 'app/pages/harbor-assistant/connections/assistant-connections-api.service';
import { AssistantConnectionsComponent } from 'app/pages/harbor-assistant/connections/assistant-connections.component';
import * as prefix from 'app/pages/harbor-assistant/services/harbor-assistant-api-prefix';

describe('Native Assistant connections', () => {
  let spectator: Spectator<AssistantConnectionsComponent>;
  const api = {
    createFeishuIdentityChallenge: jest.fn(),
    feishuIdentityChallengeStatus: jest.fn(),
    status: jest.fn(),
    configureFeishu: jest.fn(),
    startWeixinLogin: jest.fn(),
    weixinLoginStatus: jest.fn(),
    unbindWeixin: jest.fn(),
  };
  const createComponent = createComponentFactory({
    component: AssistantConnectionsComponent,
    providers: [{ provide: AssistantConnectionsApiService, useValue: api }],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    api.status.mockReturnValue(of({
      session_code: 'private-code',
      feishu: { configured: false, app_id: 'existing-app' },
      weixin: { configured: true },
    }));
    api.configureFeishu.mockReturnValue(of({ success: true }));
    api.startWeixinLogin.mockReturnValue(of({
      ok: true,
      weixin_login: { status: 'wait', qrcode_url: 'https://weixin.example/login/qr' },
    }));
    api.unbindWeixin.mockReturnValue(of({ ok: true }));
    api.createFeishuIdentityChallenge.mockReturnValue(of({
      challenge_id: 'challenge-1',
      challenge_text: 'HARBOR-BIND SYNTHETIC-ONE-TIME',
      expires_at: new Date(Date.now() + 300000).toISOString(),
      status: 'pending',
    }));
    api.feishuIdentityChallengeStatus.mockReturnValue(of({
      challenge_id: 'challenge-1',
      expires_at: new Date(Date.now() + 300000).toISOString(),
      status: 'pending',
    }));
    spectator = createComponent();
  });

  afterEach(() => jest.restoreAllMocks());

  async function fillFeishu(): Promise<void> {
    const loader = TestbedHarnessEnvironment.loader(spectator.fixture);
    await (await loader.getHarness(MatInputHarness.with({ selector: '[formControlName="appId"]' })))
      .setValue('new-app');
    await (await loader.getHarness(MatInputHarness.with({ selector: '[formControlName="appSecret"]' })))
      .setValue('private-secret');
    await (await loader.getHarness(MatInputHarness.with({ selector: '[formControlName="verificationToken"]' })))
      .setValue('private-verification');
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Save and verify connection' }))).click();
    spectator.detectChanges();
  }

  async function createPairing(): Promise<void> {
    api.status.mockReturnValue(of({ session_code: 'private-code', feishu: { configured: true }, weixin: { configured: false } }));
    const loader = TestbedHarnessEnvironment.loader(spectator.fixture);
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Refresh' }))).click();
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Create pairing code' }))).click();
    spectator.detectChanges();
  }

  it('displays a caller-owned one-time Feishu challenge with expiry', async () => {
    await createPairing();
    expect(api.createFeishuIdentityChallenge).toHaveBeenCalledWith();
    expect(spectator.query('.pairing-code')).toHaveText('HARBOR-BIND SYNTHETIC-ONE-TIME');
    expect(spectator.query('.identity-pairing time').getAttribute('datetime')).toBeTruthy();
    expect(spectator.element.textContent).not.toContain('Feishu account connected.');
  });

  it('clears the pairing code only after the backend confirms the binding', async () => {
    await createPairing();
    const loader = TestbedHarnessEnvironment.loader(spectator.fixture);
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Check pairing status' }))).click();
    expect(spectator.element.textContent).toContain('Waiting for the pairing message');
    api.feishuIdentityChallengeStatus.mockReturnValue(of({ challenge_id: 'challenge-1', status: 'bound' }));
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Check pairing status' }))).click();
    spectator.detectChanges();
    expect(api.feishuIdentityChallengeStatus).toHaveBeenCalledWith('challenge-1');
    expect(spectator.query('.pairing-code')).not.toExist();
    expect(spectator.element.textContent).toContain('Feishu account connected.');
  });

  it('removes a consumed failed challenge and offers creation again', async () => {
    await createPairing();
    api.feishuIdentityChallengeStatus.mockReturnValue(of({ challenge_id: 'challenge-1', status: 'failed' }));
    const loader = TestbedHarnessEnvironment.loader(spectator.fixture);
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Check pairing status' }))).click();
    spectator.detectChanges();
    expect(spectator.query('.pairing-code')).not.toExist();
    expect(spectator.element.textContent).toContain('Pairing could not be completed. Create a new code.');
    expect(spectator.element.textContent).not.toContain('Feishu account connected.');
  });

  it('automatically removes the one-time code at its server-specified expiry', fakeAsync(() => {
    api.status.mockReturnValue(of({ session_code: 'private-code', feishu: { configured: true }, weixin: { configured: false } }));
    api.createFeishuIdentityChallenge.mockReturnValue(of({
      challenge_id: 'expiring',
      challenge_text: 'HARBOR-BIND SYNTHETIC-EXPIRING',
      status: 'pending',
      expires_at: new Date(Date.now() + 50).toISOString(),
    }));
    const component = spectator.component as unknown as { refresh: () => void; createIdentityPairing: () => void };
    component.refresh();
    component.createIdentityPairing();
    spectator.detectChanges();
    expect(spectator.query('.pairing-code')).toExist();
    tick(51);
    spectator.detectChanges();
    expect(spectator.query('.pairing-code')).not.toExist();
    expect(spectator.element.textContent).toContain('Pairing code expired. Create a new code.');
    spectator.fixture.destroy();
  }));

  it('does not expose the Nexus pairing API in the HarborNavi profile', () => {
    spectator.fixture.destroy();
    jest.spyOn(prefix, 'harborAssistantGateRequiresUserToken').mockReturnValue(false);
    spectator = createComponent();
    expect(spectator.query('.identity-pairing')).not.toExist();
    expect(api.createFeishuIdentityChallenge).not.toHaveBeenCalled();
  });

  it('saves via the typed Gate API, clears credentials, and keeps the setup session out of the page', async () => {
    await fillFeishu();
    expect(api.configureFeishu).toHaveBeenCalledWith({
      session_code: 'private-code',
      app_id: 'new-app',
      app_secret: 'private-secret',
      verification_token: 'private-verification',
    });
    expect(spectator.element.textContent).toContain('Feishu connection saved and verified.');
    expect(spectator.element.innerHTML).not.toContain('private-code');
    expect(spectator.query<HTMLInputElement>('[formControlName="appSecret"]').value).toBe('');
    expect(spectator.query<HTMLInputElement>('[formControlName="verificationToken"]').value).toBe('');
  });

  it('does not report success when Feishu rejects the credentials', async () => {
    api.configureFeishu.mockReturnValue(of({ success: false }));
    await fillFeishu();
    expect(spectator.element.textContent).toContain('Feishu connection could not be verified.');
    expect(spectator.element.textContent).not.toContain('saved and verified');
    expect(spectator.element.innerHTML).not.toContain('private-secret');
  });

  it('displays a login QR only after the authenticated start action succeeds', async () => {
    const loader = TestbedHarnessEnvironment.loader(spectator.fixture);
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Connect WeChat' }))).click();
    spectator.detectChanges();
    expect(api.startWeixinLogin).toHaveBeenCalledTimes(1);
    expect(spectator.query('qr-code')).toExist();
    expect(spectator.element.textContent).toContain('Scan the QR code in WeChat');
  });

  it('surfaces a rejected disconnect and retains the connected status', async () => {
    api.unbindWeixin.mockReturnValue(throwError(() => new Error('Forbidden')));
    const loader = TestbedHarnessEnvironment.loader(spectator.fixture);
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Disconnect WeChat' }))).click();
    spectator.detectChanges();
    expect(spectator.element.textContent).toContain('The WeChat action did not complete.');
    expect(spectator.element.textContent).not.toContain('account disconnected');
  });
});
