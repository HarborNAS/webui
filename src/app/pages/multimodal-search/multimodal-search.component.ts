import { Component, inject, OnInit, DestroyRef, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';

import { ImageSearchService } from './services/image-search.service';
import { VideoSearchService } from './services/video-search.service';
import { DocumentSearchService } from './services/document-search.service';

@Component({
  selector: 'ix-multimodal-search',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatInputModule,
    MatIconModule,
    MatTabsModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatSnackBarModule,
  ],
  templateUrl: './multimodal-search.component.html',
  styleUrls: ['./multimodal-search.component.scss'],
  providers: [
    ImageSearchService,
    VideoSearchService,
    DocumentSearchService,
  ],
})
export class MultimodalSearchComponent implements OnInit {
  private snackBar = inject(MatSnackBar);
  private imageSearchService = inject(ImageSearchService);
  private videoSearchService = inject(VideoSearchService);
  private documentSearchService = inject(DocumentSearchService);
  private destroyRef = inject(DestroyRef);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);

  query = '';
  selectedTab = 0;
  loading = false;

  imageResults: any[] = [];
  videoResults: any[] = [];
  documentResults: any[] = [];

  chatMessages: { role: string; content: string }[] = [];
  chatInput = '';

  previewImage: any = null;
  previewIndex = 0;
  showPreview = false;

  ngOnInit(): void {
    this.addChatMessage('assistant', '欢迎使用 HarborOS 多模态知识检索系统！我可以帮您搜索图片、视频和文档。请输入您想要搜索的内容。');
    
    // Check for query parameter from desktop search
    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(params => {
        const queryParam = params['query'];
        const searchType = params['type'];
        if (queryParam) {
          this.query = queryParam;
          if (searchType === 'comprehensive') {
            // Perform comprehensive search (all types)
            this.performComprehensiveSearch(queryParam);
          } else {
            this.onSearch();
          }
        }
      });
  }

  onSearch(): void {
    if (!this.query.trim()) {
      this.showSnackbar('请输入搜索内容');
      return;
    }

    this.addChatMessage('user', this.query);
    this.loading = true;
    this.cdr.detectChanges();
    this.searchCount = 0;
    this.totalSearches = 1;

    // 根据当前选中的tab页调用相应的搜索接口
    switch (this.selectedTab) {
      case 0: // 图片搜索
        this.searchImages(this.query);
        break;
      case 1: // 视频搜索
        this.searchVideos(this.query);
        break;
      case 2: // 文档搜索
        this.searchDocuments(this.query);
        break;
      default:
        // 默认调用图片搜索
        this.searchImages(this.query);
        break;
    }

    this.query = '';
    this.cdr.detectChanges();
  }

  private searchCount = 0;
  private totalSearches = 0;

  performComprehensiveSearch(query: string): void {
    this.loading = true;
    this.cdr.detectChanges();
    this.addChatMessage('user', query);
    
    // Reset search counters
    this.searchCount = 0;
    this.totalSearches = 3; // Image, Video, Document
    
    // Search all types simultaneously
    this.searchImages(query);
    this.searchVideos(query);
    this.searchDocuments(query);
  }

  searchImages(query: string): void {
    this.imageSearchService.search(query, 1, 20)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.imageResults = response.results || [];
          this.cdr.detectChanges();
          this.checkSearchComplete();
        },
        error: (error) => {
          console.error('Image search error:', error);
          this.imageResults = [];
          this.cdr.detectChanges();
          this.checkSearchComplete();
        },
      });
  }

  searchVideos(query: string): void {
    this.videoSearchService.search(query, 1, 20)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.videoResults = response.results || [];
          this.cdr.detectChanges();
          this.checkSearchComplete();
        },
        error: (error) => {
          console.error('Video search error:', error);
          this.videoResults = [];
          this.cdr.detectChanges();
          this.checkSearchComplete();
        },
      });
  }

  searchDocuments(query: string): void {
    this.documentSearchService.search(query)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.documentResults = response.results || [];
          this.cdr.detectChanges();
          this.checkSearchComplete();
        },
        error: (error) => {
          console.error('Document search error:', error);
          this.documentResults = [];
          this.cdr.detectChanges();
          this.checkSearchComplete();
        },
      });
  }

  private checkSearchComplete(): void {
    this.searchCount++;
    
    // Only complete when all searches are done
    if (this.searchCount >= this.totalSearches) {
      this.loading = false;
      this.addChatMessage('assistant', `搜索完成！找到 ${this.imageResults.length} 张图片，${this.videoResults.length} 个视频，${this.documentResults.length} 个文档。`);
      this.cdr.detectChanges();
    }
  }

  onChatSend(): void {
    if (!this.chatInput.trim()) return;

    const inputText = this.chatInput;
    this.chatInput = '';
    this.cdr.detectChanges();

    this.addChatMessage('user', inputText);
    this.loading = true;
    this.cdr.detectChanges();
    this.searchCount = 0;
    this.totalSearches = 1;

    // 根据当前选中的tab页调用相应的搜索接口
    switch (this.selectedTab) {
      case 0: // 图片搜索
        this.searchImages(inputText);
        break;
      case 1: // 视频搜索
        this.searchVideos(inputText);
        break;
      case 2: // 文档搜索
        this.searchDocuments(inputText);
        break;
      default:
        // 默认调用图片搜索
        this.searchImages(inputText);
        break;
    }
  }

  private addChatMessage(role: string, content: string): void {
    this.chatMessages.push({ role, content });
    this.cdr.detectChanges();
  }

  private showSnackbar(message: string): void {
    this.snackBar.open(message, '关闭', {
      duration: 3000,
      horizontalPosition: 'center',
      verticalPosition: 'bottom',
    });
  }

  getUserMessages(): { role: string; content: string }[] {
    return this.chatMessages.filter(m => m.role === 'user');
  }

  openPreview(image: any, index: number): void {
    this.previewImage = image;
    this.previewIndex = index;
    this.showPreview = true;
    this.cdr.detectChanges();
  }

  closePreview(): void {
    this.showPreview = false;
    this.previewImage = null;
    this.previewIndex = 0;
    this.cdr.detectChanges();
  }

  nextImage(): void {
    if (this.imageResults.length === 0) return;
    this.previewIndex = (this.previewIndex + 1) % this.imageResults.length;
    this.previewImage = this.imageResults[this.previewIndex];
    this.cdr.detectChanges();
  }

  prevImage(): void {
    if (this.imageResults.length === 0) return;
    this.previewIndex = (this.previewIndex - 1 + this.imageResults.length) % this.imageResults.length;
    this.previewImage = this.imageResults[this.previewIndex];
    this.cdr.detectChanges();
  }
}
