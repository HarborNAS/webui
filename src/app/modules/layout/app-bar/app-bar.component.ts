import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IxIconComponent } from 'app/modules/ix-icon/ix-icon.component';


@Component({
  selector: 'ix-app-bar',
  templateUrl: './app-bar.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IxIconComponent, RouterLink],
})
export class AppBarComponent {

}
