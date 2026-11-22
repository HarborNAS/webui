import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialogActions,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { marker as T } from '@biesbjerg/ngx-translate-extract-marker';
import { TranslateModule } from '@ngx-translate/core';
import { finalize } from 'rxjs/operators';
import {
  FileBrowseEntry,
  FilesBrowseResponse,
} from 'app/pages/harbor-assistant/interfaces/harbor-assistant-status.interface';
import { HarborAssistantApiService } from 'app/pages/harbor-assistant/services/harbor-assistant-api.service';

export interface HarborAssistantFolderBrowserDialogData {
  title: string;
  currentPath: string;
  excludePaths?: string[];
  confirmLabel?: string;
  itemSelectLabel?: string;
}

export interface HarborAssistantFolderBrowserDialogResult {
  path: string;
}

@Component({
  selector: 'ix-harbor-assistant-folder-browser-dialog',
  template: `
    <h2 mat-dialog-title>{{ data.title | translate }}</h2>
    <mat-dialog-content class="assistant-folder-browser-dialog">
      @if (error()) {
        <div class="notice error compact">{{ error() | translate }}</div>
      }

      <mat-form-field>
        <mat-label>{{ 'Selected folder' | translate }}</mat-label>
        <input matInput readonly [value]="selectedPath()" />
      </mat-form-field>

      @if (browse(); as current) {
        <section class="browser-current-path">
          <div>
            <span>{{ 'Current folder' | translate }}</span>
            <strong>{{ current.path }}</strong>
          </div>
          <div class="row-actions">
            @if (current.parent) {
              <button mat-button type="button" [disabled]="loading()" (click)="openFolder(current.parent)">
                {{ 'Up' | translate }}
              </button>
            }
            <button
              mat-button
              color="primary"
              type="button"
              [disabled]="loading() || isExcluded(current.path)"
              (click)="useFolder(current.path)"
            >
              {{ confirmLabel() | translate }}
            </button>
          </div>
        </section>

        @if (folderEntries().length === 0) {
          <div class="empty-state">{{ 'No folders are available here.' | translate }}</div>
        } @else {
          <div class="folder-browser-list">
            @for (entry of folderEntries(); track entry.path) {
              <article
                class="folder-browser-row"
                [class.selected]="selectedPath() === entry.path"
                [class.excluded]="isExcluded(entry.path)"
              >
                <button
                  mat-button
                  type="button"
                  class="folder-browser-main"
                  [disabled]="loading()"
                  (click)="openFolder(entry.path)"
                >
                  <span>{{ entry.name }}</span>
                  <small>{{ entry.path }}</small>
                </button>
                <button
                  mat-button
                  type="button"
                  [disabled]="loading() || isExcluded(entry.path)"
                  (click)="useFolder(entry.path)"
                >
                  {{ itemSelectLabel() | translate }}
                </button>
              </article>
            }
          </div>
        }
      } @else {
        <div class="empty-state">{{ loading() ? ('Loading folders...' | translate) : ('No folder data yet.' | translate) }}</div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="close()">{{ 'Cancel' | translate }}</button>
      <button mat-button color="primary" type="button" [disabled]="loading() || !selectedPath()" (click)="confirmSelection()">
        {{ confirmLabel() | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .assistant-folder-browser-dialog {
      display: grid;
      gap: 12px;
      min-width: min(720px, 82vw);
    }

    mat-form-field {
      width: 100%;
    }

    .browser-current-path,
    .folder-browser-row {
      align-items: center;
      border: 1px solid var(--lines);
      border-radius: 4px;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      padding: 10px 12px;
    }

    .browser-current-path span,
    .folder-browser-main small {
      color: var(--fg2);
      display: block;
      margin-top: 2px;
    }

    .folder-browser-list {
      display: grid;
      gap: 8px;
      max-height: min(420px, 50vh);
      overflow: auto;
    }

    .folder-browser-row.selected {
      border-color: var(--primary);
    }

    .folder-browser-row.excluded {
      opacity: 0.58;
    }

    .folder-browser-main {
      justify-content: flex-start;
      min-width: 0;
      text-align: left;
      width: 100%;
    }

    .folder-browser-main span,
    .folder-browser-main small,
    .browser-current-path strong {
      overflow-wrap: anywhere;
    }

    .row-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }

    .notice,
    .empty-state {
      border: 1px solid var(--lines);
      border-radius: 4px;
      padding: 10px 12px;
    }

    .notice.error {
      border-color: var(--red);
      color: var(--red);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatButton,
    MatDialogActions,
    MatDialogContent,
    MatDialogTitle,
    MatFormField,
    MatInput,
    MatLabel,
    TranslateModule,
  ],
})
export class HarborAssistantFolderBrowserDialogComponent implements OnInit {
  private readonly harborAssistantApi = inject(HarborAssistantApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogRef = inject<
    MatDialogRef<HarborAssistantFolderBrowserDialogComponent, HarborAssistantFolderBrowserDialogResult>
  >(MatDialogRef);

  protected readonly data = inject<HarborAssistantFolderBrowserDialogData>(MAT_DIALOG_DATA);
  protected readonly browse = signal<FilesBrowseResponse | null>(null);
  protected readonly selectedPath = signal(this.normalizePath(this.data.currentPath));
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly folderEntries = computed(() => {
    return (this.browse()?.entries ?? []).filter((entry: FileBrowseEntry) => entry.is_dir);
  });
  protected readonly confirmLabel = computed(() => this.data.confirmLabel ?? T('Use this folder'));
  protected readonly itemSelectLabel = computed(() => this.data.itemSelectLabel ?? T('Use'));

  ngOnInit(): void {
    this.openFolder(this.selectedPath());
  }

  protected openFolder(path?: string | null): void {
    const targetPath = this.normalizePath(path);
    this.loading.set(true);
    this.error.set(null);

    this.harborAssistantApi.browseFiles(targetPath).pipe(
      finalize(() => this.loading.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (response) => {
        this.browse.set(response);
        this.selectedPath.set(response.path || targetPath);
      },
      error: (error: unknown) => this.error.set(this.getErrorMessage(error)),
    });
  }

  protected useFolder(path: string): void {
    const selected = this.normalizePath(path);
    if (this.isExcluded(selected)) {
      return;
    }
    this.dialogRef.close({ path: selected });
  }

  protected confirmSelection(): void {
    this.useFolder(this.selectedPath());
  }

  protected close(): void {
    this.dialogRef.close();
  }

  protected isExcluded(path: string): boolean {
    const normalized = this.normalizePath(path);
    return (this.data.excludePaths ?? []).some((excluded) => this.normalizePath(excluded) === normalized);
  }

  private normalizePath(path?: string | null): string {
    const trimmed = (path ?? '').trim();
    return trimmed || '/mnt';
  }

  private getErrorMessage(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }

    return T('Unable to browse folders. Try again later.');
  }
}
