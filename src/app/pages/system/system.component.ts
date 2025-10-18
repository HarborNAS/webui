import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
import { MatNavList, MatListItem } from '@angular/material/list';
import {
  MatDrawerContainer,
  MatDrawer,
  MatDrawerContent,
} from '@angular/material/sidenav';
import { RouterOutlet, RouterModule } from '@angular/router';
import { UntilDestroy } from '@ngneat/until-destroy';
import { SubMenuItem } from 'app/interfaces/menu-item.interface';
import { PageHeaderComponent } from 'app/modules/page-header/page-title-header/page-header.component';
import { NavigationService } from 'app/services/navigation/navigation.service';

@UntilDestroy()
@Component({
  selector: 'ix-system',
  templateUrl: './system.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    RouterOutlet,
    RouterModule,
    MatDrawerContainer,
    MatDrawer,
    MatDrawerContent,
    MatNavList,
    MatListItem,
  ],
})
export class SystemComponent implements OnInit {
  private navService = inject(NavigationService);
  menuItems = [] as SubMenuItem[];


  ngOnInit(): void {
    this.buildMenuItems();
  }

  private buildMenuItems(): void {
    this.menuItems = this.navService.menuItems.find((item) => item.state === 'system')?.sub;
  }
}
