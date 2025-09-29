import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '@ngrx/store';
import { IxIconComponent } from 'app/modules/ix-icon/ix-icon.component';
import { selectAppBarState } from 'app/store/app-bar/app-bar.selectors';

@Component({
  selector: 'ix-app-bar',
  templateUrl: './app-bar.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IxIconComponent, RouterLink, AsyncPipe],
})
export class AppBarComponent {
  // 导入 app-bar store
  private store = inject(Store);

  // 订阅 app-bar 状态
  readonly appBarState$ = this.store.select(selectAppBarState);

  getRouterLink(url: string): string[] {
    return ['/', ...url.split('/')];
  }
}
