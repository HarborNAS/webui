import { HarnessLoader } from '@angular/cdk/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { signal } from '@angular/core';
import { MatMenuHarness } from '@angular/material/menu/testing';
import { createComponentFactory, mockProvider, Spectator } from '@ngneat/spectator/jest';
import { provideMockStore } from '@ngrx/store/testing';
import { mockApi, mockCall } from 'app/core/testing/utils/mock-api.utils';
import { mockAuth } from 'app/core/testing/utils/mock-auth.utils';
import { ContainerDeviceType, containerGpuType, ContainerType } from 'app/enums/container.enum';
import { ContainerDevice, ContainerGpuChoice } from 'app/interfaces/container.interface';
import { SnackbarService } from 'app/modules/snackbar/services/snackbar.service';
import { ApiService } from 'app/modules/websocket/api.service';
import {
  AddGpuDeviceMenuComponent,
} from 'app/pages/containers/components/all-containers/container-details/container-gpu-devices/add-gpu-device-menu/add-gpu-device-menu.component';
import { ContainerDevicesStore } from 'app/pages/containers/stores/container-devices.store';
import { ContainersStore } from 'app/pages/containers/stores/containers.store';
import { selectAdvancedConfig } from 'app/store/system-config/system-config.selectors';

describe('AddGpuDeviceMenuComponent', () => {
  let spectator: Spectator<AddGpuDeviceMenuComponent>;
  let loader: HarnessLoader;
  const selectedContainer = signal({
    id: 123,
    type: ContainerType.Container,
  });
  let gpuChoices: Record<string, ContainerGpuChoice> = {
    '0000:19:00.0': containerGpuType.Nvidia,
    '0000:1a:00.0': containerGpuType.Amd,
  };
  const createComponent = createComponentFactory({
    component: AddGpuDeviceMenuComponent,
    providers: [
      mockAuth(),
      mockApi([
        mockCall('container.device.create'),
      ]),
      provideMockStore({
        selectors: [
          {
            selector: selectAdvancedConfig,
            value: {
              nvidia: true,
            },
          },
        ],
      }),
      mockProvider(ContainersStore, {
        selectedContainer,
      }),
      mockProvider(ContainerDevicesStore, {
        devices: () => [
          {
            dtype: ContainerDeviceType.Gpu,
            gpu_type: containerGpuType.Nvidia,
            pci_address: '0000:19:00.0',
          } as ContainerDevice,
        ] as ContainerDevice[],
        gpuChoices: () => gpuChoices,
        isLoadingGpuChoices: () => false,
        reload: jest.fn(),
        isLoading: () => false,
      }),
      mockProvider(SnackbarService),
    ],
  });

  beforeEach(() => {
    gpuChoices = {
      '0000:19:00.0': containerGpuType.Nvidia,
      '0000:1a:00.0': containerGpuType.Amd,
    };
    spectator = createComponent();
    loader = TestbedHarnessEnvironment.loader(spectator.fixture);
  });

  it('shows available GPU devices that have not been already added to this container', async () => {
    const menu = await loader.getHarness(MatMenuHarness.with({ triggerText: 'Add' }));
    await menu.open();

    const menuItems = await menu.getItems();
    expect(menuItems).toHaveLength(1);
    expect(await menuItems[0].getText()).toContain('AMD (0000:1a:00.0)');
  });

  it('adds a GPU device when it is selected', async () => {
    const menu = await loader.getHarness(MatMenuHarness.with({ triggerText: 'Add' }));
    await menu.open();

    await menu.clickItem({ text: 'AMD (0000:1a:00.0)' });

    expect(spectator.inject(ApiService).call).toHaveBeenCalledWith('container.device.create', [{
      container: 123,
      attributes: {
        dtype: ContainerDeviceType.Gpu,
        gpu_type: 'AMD',
        pci_address: '0000:1a:00.0',
      } as ContainerDevice,
    }]);
    expect(spectator.inject(ContainerDevicesStore).reload).toHaveBeenCalled();
    expect(spectator.inject(SnackbarService).success).toHaveBeenCalledWith('GPU Device was added');
  });

  it('shows W7900 BAR failure guidance and disables the GPU menu item', async () => {
    gpuChoices = {
      '0000:03:00.0': {
        pci_slot: '0000:03:00.0',
        gpu_type: containerGpuType.Amd,
        description: 'AMD Radeon PRO W7900 (0000:03:00.0)',
        available: false,
        error: 'amd_w7900_bar_rebar_failure',
        failure_reason: 'amd_w7900_bar_rebar_failure',
        capabilities: [],
        recommended_actions: [
          'Append the recommended kernel options via system.advanced.update and reboot once.',
        ],
        os_profile: {
          kernel_extra_options: 'pci=realloc=on,big_root_window,resource_alignment=36@0000:00:01.1',
        },
      },
    };
    spectator = createComponent();
    loader = TestbedHarnessEnvironment.loader(spectator.fixture);

    const menu = await loader.getHarness(MatMenuHarness.with({ triggerText: 'Add' }));
    await menu.open();

    const menuItems = await menu.getItems();
    expect(menuItems).toHaveLength(1);
    expect(await menuItems[0].getText()).toContain('W7900 BAR allocation failed');
    expect(await menuItems[0].getText()).toContain('resource_alignment=36@0000:00:01.1');
    expect(await menuItems[0].isDisabled()).toBe(true);
  });

  it('does not expose placeholder kernel options before the upstream bridge is confirmed', async () => {
    gpuChoices = {
      '0000:03:00.0': {
        pci_slot: '0000:03:00.0',
        gpu_type: containerGpuType.Amd,
        description: 'AMD Radeon PRO W7900 (0000:03:00.0)',
        available: false,
        error: 'amd_w7900_bar_rebar_failure',
        failure_reason: 'amd_w7900_bar_rebar_failure',
        os_profile: {
          kernel_extra_options: 'resource_alignment=36@<upstream_bridge_pci_slot>',
          manual_bridge_confirmation_required: true,
        },
      },
    };
    spectator = createComponent();
    loader = TestbedHarnessEnvironment.loader(spectator.fixture);

    const menu = await loader.getHarness(MatMenuHarness.with({ triggerText: 'Add' }));
    await menu.open();

    const menuText = await (await menu.getItems())[0].getText();
    expect(menuText).toContain('confirm the upstream bridge');
    expect(menuText).not.toContain('resource_alignment');
  });
});
