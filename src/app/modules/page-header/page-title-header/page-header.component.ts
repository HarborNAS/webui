import { AsyncPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslateModule } from '@ngx-translate/core';
import { map } from 'rxjs/operators';
import { IxIconComponent } from 'app/modules/ix-icon/ix-icon.component';
import { LayoutService } from 'app/modules/layout/layout.service';
import { PageTitleService } from 'app/modules/layout/page-title.service';
import { FakeProgressBarComponent } from 'app/modules/loader/components/fake-progress-bar/fake-progress-bar.component';
// import { BreadcrumbComponent } from 'app/modules/page-header/breadcrumb/breadcrumb.component';
import { HeaderBadgeComponent } from 'app/modules/page-header/header-badge/header-badge.component';
import { TooltipComponent } from 'app/modules/tooltip/tooltip.component';
import { appBarClosed } from 'app/store/app-bar/app-bar.actions';

@Component({
  selector: 'ix-page-header',
  templateUrl: './page-header.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    // BreadcrumbComponent,
    HeaderBadgeComponent,
    FakeProgressBarComponent,
    TranslateModule,
    AsyncPipe,
    TooltipComponent,
    IxIconComponent,
    RouterLink,
  ],
})
export class PageHeaderComponent implements OnInit, OnDestroy {
  private pageTitleService = inject(PageTitleService);
  private layoutService = inject(LayoutService);
  private router = inject(Router);

  // 新增 store 注入
  private store = inject(Store);

  readonly pageTitle = input<string>();
  readonly customBadgeTitle = input<string>();
  readonly tooltip = input<string>();
  readonly loading = input(false);

  readonly default = input(false);

  readonly defaultTitle$ = this.pageTitleService.title$;
  readonly hasNewIndicator$ = this.pageTitleService.hasNewIndicator$;
  readonly currentTitle$ = this.defaultTitle$.pipe(
    map((defaultTitle) => {
      if (!this.pageTitle()) {
        return defaultTitle;
      }
      return this.pageTitle();
    }),
  );

  ngOnInit(): void {
    if (!this.default()) {
      this.layoutService.hasCustomPageHeader$.next(true);
    }
  }

  ngOnDestroy(): void {
    if (!this.default()) {
      this.layoutService.hasCustomPageHeader$.next(false);
    }
  }

  minimize(): void {
    // 通知 appBarStore 收起当前页面
    this.store.dispatch(appBarClosed({ name: this.pageTitle() || 'Desktop' }));
    // 可选：跳转到桌面
    this.router.navigate(['/desktop']);
  }
}
