import { ChangeDetectionStrategy, Component, computed, inject, DestroyRef } from '@angular/core';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { Store } from '@ngrx/store';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import { catchError, of } from 'rxjs';
import { RequiresRolesDirective } from 'app/directives/requires-roles/requires-roles.directive';
import { ContainerDeviceType, containerGpuType } from 'app/enums/container.enum';
import { Role } from 'app/enums/role.enum';
import { AvailableGpu, ContainerGpuChoice, ContainerGpuDevice } from 'app/interfaces/container.interface';
import { LoaderService } from 'app/modules/loader/loader.service';
import { SnackbarService } from 'app/modules/snackbar/services/snackbar.service';
import { TestDirective } from 'app/modules/test-id/test.directive';
import { ApiService } from 'app/modules/websocket/api.service';
import { ContainerDevicesStore } from 'app/pages/containers/stores/container-devices.store';
import { ContainersStore } from 'app/pages/containers/stores/containers.store';
import { ErrorHandlerService } from 'app/services/errors/error-handler.service';
import { AppState } from 'app/store';
import { waitForAdvancedConfig } from 'app/store/system-config/system-config.selectors';

interface GpuMenuItem {
  pciAddress: string;
  gpuType: string;
  description: string;
  status: string | null;
  disabled: boolean;
}

@Component({
  selector: 'ix-add-gpu-device-menu',
  templateUrl: './add-gpu-device-menu.component.html',
  styleUrls: ['./add-gpu-device-menu.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatButton,
    MatMenu,
    MatMenuItem,
    TestDirective,
    TranslateModule,
    MatMenuTrigger,
    NgxSkeletonLoaderModule,
    RequiresRolesDirective,
  ],
})
export class AddGpuDeviceMenuComponent {
  protected readonly requiredRoles = [Role.ContainerWrite];

  private destroyRef = inject(DestroyRef);
  private api = inject(ApiService);
  private errorHandler = inject(ErrorHandlerService);
  private loader = inject(LoaderService);
  private snackbar = inject(SnackbarService);
  private translate = inject(TranslateService);
  private devicesStore = inject(ContainerDevicesStore);
  private containersStore = inject(ContainersStore);
  private store$ = inject<Store<AppState>>(Store);

  protected readonly nvidiaDriversEnabled = toSignal(
    this.store$.pipe(waitForAdvancedConfig).pipe(
      catchError(() => of({ nvidia: false })),
    ),
  );

  protected readonly isLoading = computed(() => {
    const devicesLoading = this.devicesStore.isLoading();
    const gpuChoicesLoading = this.devicesStore.isLoadingGpuChoices();
    return devicesLoading || gpuChoicesLoading;
  });

  protected readonly availableGpuDevices = computed(() => {
    const gpuChoices = this.devicesStore.gpuChoices();
    const nvidiaEnabled = this.nvidiaDriversEnabled()?.nvidia ?? false;

    if (!gpuChoices) {
      return [];
    }

    const existingGpuDevices = this.devicesStore.devices()
      .filter((device) => device.dtype === ContainerDeviceType.Gpu);

    return Object.entries(gpuChoices)
      .map(([pciAddress, gpuChoice]) => this.gpuMenuItemFromChoice(pciAddress, gpuChoice))
      .filter((gpu) => {
        const isAlreadyAdded = existingGpuDevices
          .some((device) => device.pci_address === gpu.pciAddress);

        // Filter out NVIDIA GPUs if drivers aren't enabled
        if (gpu.gpuType === containerGpuType.Nvidia && !nvidiaEnabled) {
          return false;
        }

        return !isAlreadyAdded;
      });
  });

  protected readonly hasDevicesToAdd = computed(() => {
    return this.availableGpuDevices().length > 0;
  });

  protected addGpu(gpu: GpuMenuItem): void {
    if (gpu.disabled) {
      return;
    }

    this.addDevice({
      dtype: ContainerDeviceType.Gpu,
      gpu_type: gpu.gpuType,
      pci_address: gpu.pciAddress,
    } as ContainerGpuDevice);
  }

  private gpuMenuItemFromChoice(pciAddress: string, gpuChoice: ContainerGpuChoice): GpuMenuItem {
    if (typeof gpuChoice === 'string') {
      return {
        pciAddress,
        gpuType: gpuChoice,
        description: `${gpuChoice} (${pciAddress})`,
        status: null,
        disabled: false,
      };
    }

    return {
      pciAddress,
      gpuType: gpuChoice.gpu_type,
      description: gpuChoice.description || `${gpuChoice.gpu_type} (${pciAddress})`,
      status: this.getGpuStatus(gpuChoice),
      disabled: Boolean(gpuChoice.failure_reason || gpuChoice.error || gpuChoice.available === false),
    };
  }

  private getGpuStatus(gpu: AvailableGpu): string | null {
    if (gpu.failure_reason === 'amd_w7900_bar_rebar_failure') {
      return this.getW7900BarFailureStatus(gpu);
    }

    if (gpu.failure_reason) {
      return this.translate.instant(this.getFailureLabel(gpu.failure_reason));
    }

    if (gpu.capabilities?.includes('container-rocm')) {
      return this.translate.instant('Ready for ROCm containers');
    }

    if (gpu.capabilities?.includes('container-cuda')) {
      return this.translate.instant('Ready for CUDA containers');
    }

    if (gpu.capabilities?.includes('container-intel-arc')) {
      return this.translate.instant('Ready for Intel Arc containers');
    }

    return null;
  }

  private getFailureLabel(reason: string): string {
    const failureLabels: Record<string, string> = {
      amd_w7900_bar_rebar_failure: 'W7900 BAR allocation failed; IT confirmation and one reboot are required',
      amd_pcie_bar_resource_failure: 'AMD PCIe BAR allocation failed; confirm hardware profile before changing boot options',
      amd_kfd_missing: 'AMD driver is loaded but /dev/kfd is missing',
      amd_render_node_missing: 'AMD render device is missing',
      intel_igpu_non_target: 'Intel integrated graphics is not a target accelerator',
      intel_arc_render_node_missing: 'Intel Arc render device is missing',
      nvidia_container_runtime_missing: 'NVIDIA container runtime is missing',
      nvidia_device_nodes_missing: 'NVIDIA device nodes are missing',
      nvidia_procfs_details_missing: 'NVIDIA driver details are missing',
    };

    return failureLabels[reason] || reason;
  }

  private getW7900BarFailureStatus(gpu: AvailableGpu): string {
    if (gpu.os_profile?.['manual_bridge_confirmation_required'] === true) {
      return this.translate.instant(
        'W7900 BAR allocation failed; ask IT to confirm the upstream bridge before generating kernel options.',
      );
    }

    const kernelOptions = gpu.os_profile?.['kernel_extra_options'];
    const suffix = typeof kernelOptions === 'string'
      ? this.translate.instant(' Recommended kernel options: {options}', { options: kernelOptions })
      : '';

    return this.translate.instant(
      'W7900 BAR allocation failed; ask IT to append kernel options through Advanced Settings and reboot once.',
    ) + suffix;
  }

  private addDevice(payload: Partial<ContainerGpuDevice>): void {
    const instanceId = this.containersStore.selectedContainer()?.id;
    if (!instanceId) {
      return;
    }

    this.api.call('container.device.create', [{
      container: instanceId,
      attributes: payload as ContainerGpuDevice,
    }])
      .pipe(
        this.loader.withLoader(),
        this.errorHandler.withErrorHandler(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.snackbar.success(this.translate.instant('GPU Device was added'));
        this.devicesStore.reload();
      });
  }
}
