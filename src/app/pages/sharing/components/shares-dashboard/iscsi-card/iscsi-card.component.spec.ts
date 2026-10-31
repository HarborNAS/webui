import { HarnessLoader } from '@angular/cdk/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatButtonHarness } from '@angular/material/button/testing';
import { MatMenuHarness } from '@angular/material/menu/testing';
import { Spectator } from '@ngneat/spectator';
import { createComponentFactory, mockProvider } from '@ngneat/spectator/jest';
import { provideMockStore } from '@ngrx/store/testing';
import { MockComponents } from 'ng-mocks';
import { of } from 'rxjs';
import { mockApi, mockCall } from 'app/core/testing/utils/mock-api.utils';
import { mockAuth } from 'app/core/testing/utils/mock-auth.utils';
import { IscsiAuthMethod, IscsiTargetMode } from 'app/enums/iscsi.enum';
import { ServiceName } from 'app/enums/service-name.enum';
import { ServiceStatus } from 'app/enums/service-status.enum';
import { IscsiTarget } from 'app/interfaces/iscsi.interface';
import { Service } from 'app/interfaces/service.interface';
import { DialogService } from 'app/modules/dialog/dialog.service';
import { IxTableHarness } from 'app/modules/ix-table/components/ix-table/ix-table.harness';
import { SlideIn } from 'app/modules/slide-ins/slide-in';
import { SlideInRef } from 'app/modules/slide-ins/slide-in-ref';
import { IscsiCardComponent } from 'app/pages/sharing/components/shares-dashboard/iscsi-card/iscsi-card.component';
import {
  ServiceExtraActionsComponent,
} from 'app/pages/sharing/components/shares-dashboard/service-extra-actions/service-extra-actions.component';
import {
  ServiceStateButtonComponent,
} from 'app/pages/sharing/components/shares-dashboard/service-state-button/service-state-button.component';
import { IscsiWizardComponent } from 'app/pages/sharing/iscsi/iscsi-wizard/iscsi-wizard.component';
import { LicenseService } from 'app/services/license.service';
import { selectServices } from 'app/store/services/services.selectors';

describe('IscsiCardComponent', () => {
  let spectator: Spectator<IscsiCardComponent>;
  let loader: HarnessLoader;
  let table: IxTableHarness;

  const iscsiShares = [
    {
      id: 6,
      name: 'grow',
      alias: 'kokok',
      mode: IscsiTargetMode.Both,
      auth_networks: [],
      groups: [
        {
          portal: 1,
          initiator: 4,
          auth: null,
          authmethod: IscsiAuthMethod.None,
        },
      ],
    },
  ] as IscsiTarget[];

  const slideInRef: SlideInRef<undefined, unknown> = {
    close: jest.fn(),
    requireConfirmationWhen: jest.fn(),
    getData: jest.fn((): undefined => undefined),
  };

  const createComponent = createComponentFactory({
    component: IscsiCardComponent,
    declarations: [
      MockComponents(
        ServiceStateButtonComponent,
        ServiceExtraActionsComponent,
      ),
    ],
    providers: [
      mockAuth(),
      mockApi([
        mockCall('iscsi.target.query', iscsiShares),
      ]),
      mockProvider(DialogService, {
        confirm: jest.fn(() => of(true)),
      }),
      mockProvider(SlideIn, {
        open: jest.fn(() => of()),
      }),
      mockProvider(SlideInRef, slideInRef),
      mockProvider(LicenseService, {
        hasFibreChannel$: of(true),
      }),
      provideMockStore({
        initialState: {
          alerts: {
            ids: [], entities: {}, isLoading: false, isPanelOpen: false, error: null,
          },
        },
        selectors: [
          {
            selector: selectServices,
            value: [{
              id: 4,
              service: ServiceName.Iscsi,
              state: ServiceStatus.Stopped,
              enable: false,
            } as Service],
          },
        ],
      }),
    ],
  });

  beforeEach(async () => {
    spectator = createComponent();
    loader = TestbedHarnessEnvironment.loader(spectator.fixture);
    table = await loader.getHarness(IxTableHarness);
  });

  it('should render title', () => {
    expect(spectator.query('h3')).toHaveText('Block (iSCSI/FC) Shares Targets');
  });

  it('should show table rows', async () => {
    const expectedRows = [
      ['Target Name', 'Target Alias', 'Mode'],
      ['grow', 'kokok', 'Both'],
    ];

    const cells = await table.getCellTexts();
    expect(cells).toEqual(expectedRows);
  });

  it('keeps the target summary read-only after target management is removed', async () => {
    const menus = await loader.getAllHarnesses(MatMenuHarness.with({ selector: '[mat-icon-button]' }));
    expect(menus).toHaveLength(0);
    expect(spectator.query('ix-table-pager-show-more')).not.toExist();
    expect(spectator.query('.toolbar-row-title a')).toHaveAttribute('href', '/sharing/iscsi');
  });

  it('opens the existing iSCSI wizard from the dashboard', async () => {
    const wizard = await loader.getHarness(MatButtonHarness.with({ text: 'Wizard' }));
    await wizard.click();
    expect(spectator.inject(SlideIn).open).toHaveBeenCalledWith(IscsiWizardComponent, { wide: true });
  });
});
