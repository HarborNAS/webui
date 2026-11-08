import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'ix-page-header',
  templateUrl: './page-header.component.html',
  styleUrl: './page-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslateModule],
})
export class PageHeaderComponent {
  readonly pageTitle = input<string>();
  readonly loading = input(false);

  protected readonly currentTitle = computed(() => this.pageTitle() || 'Harbor Assistant');
}
