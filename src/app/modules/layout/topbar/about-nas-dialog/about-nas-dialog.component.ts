import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import { MatDialogRef, MatDialogContent, MatDialogTitle, MatDialogActions } from '@angular/material/dialog';
import { UntilDestroy } from '@ngneat/until-destroy';
import { TranslateModule } from '@ngx-translate/core';
import { filter, map } from 'rxjs';
import { GiB } from 'app/constants/bytes.constant';
import { WithLoadingStateDirective } from 'app/modules/loader/directives/with-loading-state/with-loading-state.directive';
import { WidgetResourcesService } from 'app/pages/dashboard/services/widget-resources.service';

@UntilDestroy()
@Component({
  selector: 'ix-about-nas-dialog',
  templateUrl: './about-nas-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslateModule,
    MatDialogContent,
    MatDialogTitle,
    MatButton,
    MatDialogActions,
    WithLoadingStateDirective,
  ],
  providers: [WidgetResourcesService],
})
export class AboutNasDialog {
  private dialogRef = inject<MatDialogRef<AboutNasDialog>>(MatDialogRef);
  private resources = inject(WidgetResourcesService);

  systemInfo = toSignal(this.resources.dashboardSystemInfo$.pipe(
    map((state) => state.value),
    filter((value) => !!value),
  ));

  cpuModel$ = this.resources.cpuModel$;

  protected memory = toSignal(this.resources.realtimeUpdates$.pipe(
    map((update) => update.fields.memory),
  ));

  protected formatUnit(bytes: number): string {
    return (bytes / GiB).toFixed(1);
  }

  close(): void {
    this.dialogRef.close();
  }
}
