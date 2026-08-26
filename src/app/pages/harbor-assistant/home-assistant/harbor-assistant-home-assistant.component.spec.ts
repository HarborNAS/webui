import { createComponentFactory, Spectator } from '@ngneat/spectator/jest';
import { of } from 'rxjs';
import {
  HarborAssistantHomeAssistantComponent,
} from 'app/pages/harbor-assistant/home-assistant/harbor-assistant-home-assistant.component';
import {
  HomeAssistantEntity,
  HomeAssistantInstallStatusResponse,
  HomeAssistantServiceDomain,
  HomeAssistantStatusResponse,
} from 'app/pages/harbor-assistant/interfaces/harbor-assistant-status.interface';
import { HarborAssistantApiService } from 'app/pages/harbor-assistant/services/harbor-assistant-api.service';

describe('Harbor Assistant Home Assistant component', () => {
  let spectator: Spectator<HarborAssistantHomeAssistantComponent>;
  let api: Partial<Record<keyof HarborAssistantApiService, jest.Mock>>;

  const managedStatus = {
    configured: true,
    enabled: true,
    base_url: 'harborlink://home-assistant',
    managed_by_harborlink: true,
    harborlink_available: true,
    token_configured: true,
    exposed_domains: ['light'],
    allowed_entities: ['light.kitchen'],
    allowed_cameras: ['front-door'],
    camera_entity_bindings: { 'front-door': 'camera.front_door' },
    status: 'connected',
  } as HomeAssistantStatusResponse;

  const createComponent = createComponentFactory({
    component: HarborAssistantHomeAssistantComponent,
    providers: [
      {
        provide: HarborAssistantApiService,
        useFactory: (): Partial<Record<keyof HarborAssistantApiService, jest.Mock>> => api,
      },
    ],
  });

  beforeEach(() => {
    api = {
      getHomeAssistantEntities: jest.fn(() => of({ entities: [] })),
      getHomeAssistantInstallStatus: jest.fn(() => of({
        status: 'not_installed',
      } as HomeAssistantInstallStatusResponse)),
      getHomeAssistantServices: jest.fn(() => of({ services: [] })),
      getHomeAssistantStatus: jest.fn(() => of(managedStatus)),
      saveHomeAssistantConfig: jest.fn(() => of({ status: managedStatus })),
    };
  });

  it('does not expose or resubmit the HarborLink managed endpoint marker', () => {
    spectator = createComponent();
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      configForm: {
        controls: {
          baseUrl: { setValue: (value: string) => void; value: string };
        };
      };
      saveConfig: () => void;
    };

    expect(spectator.element.textContent).toContain('Managed by HarborLink');
    expect(spectator.element.textContent).not.toContain('harborlink://home-assistant');
    expect(component.configForm.controls.baseUrl.value).toBe('');

    component.configForm.controls.baseUrl.setValue('http://homeassistant.local:8123');
    component.saveConfig();

    expect(api.saveHomeAssistantConfig).toHaveBeenCalledWith(expect.objectContaining({
      base_url: 'http://homeassistant.local:8123',
    }));
  });

  it('preserves HarborLink ownership and submits explicit allowlists without a redacted URL', () => {
    spectator = createComponent();
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      saveConfig: () => void;
    };
    component.saveConfig();

    expect(api.saveHomeAssistantConfig).toHaveBeenCalledWith({
      enabled: true,
      access_token: undefined,
      clear_access_token: false,
      exposed_domains: ['light'],
      allowed_entities: ['light.kitchen'],
      allowed_cameras: ['front-door'],
      camera_entity_bindings: { 'front-door': 'camera.front_door' },
    });
  });

  it('refreshes stale summary values from successful test and sync responses', () => {
    const staleStatus = {
      ...managedStatus,
      status: 'unknown',
      entity_count: 0,
      service_count: 0,
      version: null,
      location_name: null,
      last_sync_at: null,
    } as HomeAssistantStatusResponse;
    const entities = [
      {
        entity_id: 'sensor.room_temperature', domain: 'sensor', state: '23', display_name: 'Room temperature',
      },
      {
        entity_id: 'sensor.room_humidity', domain: 'sensor', state: '50', display_name: 'Room humidity',
      },
      {
        entity_id: 'binary_sensor.room_motion', domain: 'binary_sensor', state: 'off', display_name: 'Room motion',
      },
    ] as HomeAssistantEntity[];
    const serviceDomains = [{
      domain: 'light',
      services: [{ service: 'turn_on' }, { service: 'turn_off' }],
    }] as HomeAssistantServiceDomain[];
    api.getHomeAssistantStatus = jest.fn(() => of(staleStatus));
    api.getHomeAssistantEntities = jest.fn(() => of({ entities }));
    api.testHomeAssistantConnection = jest.fn(() => of({
      test: {
        ok: true, status: 'connected', version: '2026.8.2', location_name: 'Test home',
      },
      status: staleStatus,
    }));
    api.syncHomeAssistant = jest.fn(() => of({
      status: staleStatus,
      entities,
      service_domains: serviceDomains,
    }));

    spectator = createComponent();
    spectator.detectChanges();

    const component = spectator.component as unknown as {
      metrics: () => { label: string; value: string }[];
      status: () => HomeAssistantStatusResponse;
      statusLabel: () => string;
      syncEntities: () => void;
      testConnection: () => void;
    };
    expect(component.metrics().find((metric) => metric.label === 'Entities')?.value).toBe('3');

    component.testConnection();
    expect(component.statusLabel()).toBe('Connected');
    expect(component.metrics().find((metric) => metric.label === 'Version')?.value).toBe('2026.8.2');

    component.syncEntities();
    expect(component.statusLabel()).toBe('Synced');
    expect(component.metrics().find((metric) => metric.label === 'Entities')?.value).toBe('3');
    expect(component.metrics().find((metric) => metric.label === 'Services')?.value).toBe('2');
    expect(component.metrics().find((metric) => metric.label === 'Version')?.value).toBe('2026.8.2');
    expect(component.status().last_sync_at).toBeTruthy();
  });
});
