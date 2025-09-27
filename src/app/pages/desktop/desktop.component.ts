import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { UntilDestroy } from '@ngneat/until-destroy';
import { IxIconComponent } from 'app/modules/ix-icon/ix-icon.component';

@UntilDestroy()
@Component({
  selector: 'ix-desktop',
  templateUrl: './desktop.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IxIconComponent, RouterLink],
})

export class DesktopComponent implements OnInit {
  readonly isLoading = false;

  ngOnInit(): void {
    throw new Error('Method not implemented.');
  }
}
