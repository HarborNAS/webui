import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, effect, OnInit, signal, inject, DestroyRef } from '@angular/core';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import { MatCard } from '@angular/material/card';
import { MatToolbarRow } from '@angular/material/toolbar';
import { MatTooltip } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { TnIconComponent } from '@truenas/ui-components';
import {
  filter, startWith, tap,
} from 'rxjs';
import { iscsiCardEmptyConfig } from 'app/constants/empty-configs';
import { RequiresRolesDirective } from 'app/directives/requires-roles/requires-roles.directive';
import { UiSearchDirective } from 'app/directives/ui-search.directive';
import { IscsiTargetMode, iscsiTargetModeNames } from 'app/enums/iscsi.enum';
import { Role } from 'app/enums/role.enum';
import { ServiceName } from 'app/enums/service-name.enum';
import { IscsiTarget } from 'app/interfaces/iscsi.interface';
import { CardAlertBadgeComponent } from 'app/modules/alerts/components/card-alert-badge/card-alert-badge.component';
import { EmptyComponent } from 'app/modules/empty/empty.component';
import { EmptyService } from 'app/modules/empty/empty.service';
import { AsyncDataProvider } from 'app/modules/ix-table/classes/async-data-provider/async-data-provider';
import { IxTableComponent } from 'app/modules/ix-table/components/ix-table/ix-table.component';
import { textColumn } from 'app/modules/ix-table/components/ix-table-body/cells/ix-cell-text/ix-cell-text.component';
import { IxTableBodyComponent } from 'app/modules/ix-table/components/ix-table-body/ix-table-body.component';
import { IxTableHeadComponent } from 'app/modules/ix-table/components/ix-table-head/ix-table-head.component';
import { IxTableEmptyDirective } from 'app/modules/ix-table/directives/ix-table-empty.directive';
import { SortDirection } from 'app/modules/ix-table/enums/sort-direction.enum';
import { createTable } from 'app/modules/ix-table/utils';
import { SlideIn } from 'app/modules/slide-ins/slide-in';
import { TestDirective } from 'app/modules/test-id/test.directive';
import { ApiService } from 'app/modules/websocket/api.service';
import { iscsiCardElements } from 'app/pages/sharing/components/shares-dashboard/iscsi-card/iscsi-card.elements';
import { ServiceExtraActionsComponent } from 'app/pages/sharing/components/shares-dashboard/service-extra-actions/service-extra-actions.component';
import { ServiceStateButtonComponent } from 'app/pages/sharing/components/shares-dashboard/service-state-button/service-state-button.component';
import { IscsiWizardComponent } from 'app/pages/sharing/iscsi/iscsi-wizard/iscsi-wizard.component';
import { LicenseService } from 'app/services/license.service';
import { ServicesState } from 'app/store/services/services.reducer';
import { selectService } from 'app/store/services/services.selectors';

@Component({
  selector: 'ix-iscsi-card',
  templateUrl: './iscsi-card.component.html',
  styleUrls: ['./iscsi-card.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCard,
    MatToolbarRow,
    TestDirective,
    TnIconComponent,
    ServiceStateButtonComponent,
    RequiresRolesDirective,
    MatButton,
    UiSearchDirective,
    ServiceExtraActionsComponent,
    IxTableComponent,
    IxTableEmptyDirective,
    IxTableHeadComponent,
    IxTableBodyComponent,
    TranslateModule,
    AsyncPipe,
    RouterLink,
    MatTooltip,
    EmptyComponent,
    CardAlertBadgeComponent,
  ],
})
export class IscsiCardComponent implements OnInit {
  private slideIn = inject(SlideIn);
  private translate = inject(TranslateService);
  private api = inject(ApiService);
  protected emptyService = inject(EmptyService);
  private store$ = inject<Store<ServicesState>>(Store);
  private cdr = inject(ChangeDetectorRef);
  private license = inject(LicenseService);
  private destroyRef = inject(DestroyRef);

  service$ = this.store$.select(selectService(ServiceName.Iscsi));
  requiredRoles = [
    Role.SharingIscsiTargetWrite,
    Role.SharingIscsiWrite,
    Role.SharingWrite,
  ];

  targets = signal<IscsiTarget[] | null>(null);

  protected readonly hasFibreChannel = toSignal(
    this.license.hasFibreChannel$.pipe(startWith(false)),
  );

  protected readonly searchableElements = iscsiCardElements;
  protected readonly emptyConfig = iscsiCardEmptyConfig;
  protected readonly cardMenuPath = ['sharing', 'iscsi'];

  dataProvider: AsyncDataProvider<IscsiTarget>;

  columns = createTable<IscsiTarget>([
    textColumn({
      title: this.translate.instant('Target Name'),
      propertyName: 'name',
    }),
    textColumn({
      title: this.translate.instant('Target Alias'),
      propertyName: 'alias',
    }),
    textColumn({
      title: this.translate.instant('Mode'),
      propertyName: 'mode',
      hidden: true,
      getValue: (row) => this.translate.instant(iscsiTargetModeNames.get(row.mode) || row.mode) || '-',
    }),
  ], {
    uniqueRowTag: (row) => 'card-iscsi-target-' + row.name,
    ariaLabels: (row) => [row.name, this.translate.instant('iSCSI Target')],
  });

  constructor() {
    effect(() => {
      if (this.targets()?.some((target) => target.mode !== IscsiTargetMode.Iscsi)) {
        this.columns = this.columns.map((column) => {
          if (column.propertyName === 'mode') {
            return {
              ...column,
              hidden: false,
            };
          }

          return column;
        });
        this.cdr.detectChanges();
        this.cdr.markForCheck();
      }
    });
  }

  ngOnInit(): void {
    const iscsiShares$ = this.api.call('iscsi.target.query').pipe(
      tap((targets) => {
        this.targets.set(targets);
      }),
      takeUntilDestroyed(this.destroyRef),
    );
    this.dataProvider = new AsyncDataProvider<IscsiTarget>(iscsiShares$);
    this.setDefaultSort();
    this.dataProvider.load();
  }

  openWizard(): void {
    this.slideIn.open(IscsiWizardComponent, { wide: true }).pipe(
      filter((response) => !!response.response),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => this.dataProvider.load());
  }

  setDefaultSort(): void {
    this.dataProvider.setSorting({
      active: 0,
      direction: SortDirection.Asc,
      propertyName: 'name',
    });
  }
}
