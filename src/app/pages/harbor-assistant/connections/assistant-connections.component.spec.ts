import 'jest-canvas-mock';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatButtonHarness } from '@angular/material/button/testing';
import { MatInputHarness } from '@angular/material/input/testing';
import { createComponentFactory, Spectator } from '@ngneat/spectator/jest';
import { of, throwError } from 'rxjs';
import { AssistantConnectionsApiService } from 'app/pages/harbor-assistant/connections/assistant-connections-api.service';
import { AssistantConnectionsComponent } from 'app/pages/harbor-assistant/connections/assistant-connections.component';

describe('Native Assistant connections', () => {
  let spectator: Spectator<AssistantConnectionsComponent>;
  const api = {
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
    spectator = createComponent();
  });

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
