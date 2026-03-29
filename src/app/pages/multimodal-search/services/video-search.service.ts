import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

export interface VideoSearchResponse {
  results: VideoResult[];
  pagination: PaginationInfo;
}

export interface VideoResult {
  id: string;
  path: string;
  similarity: string;
  timestamps: number[];
  frameNumbers: number[];
}

export interface PaginationInfo {
  page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

// Extend window interface to include APIURL
declare global {
  interface Window {
    APIURL?: string;
  }
}

@Injectable({
  providedIn: 'root',
})
export class VideoSearchService {
  private get API_BASE_URL(): string {
    const apiUrl = window.APIURL || 'localhost:50313';
    return `http://${apiUrl}`;
  }

  constructor(private http: HttpClient) {}

  search(query: string, page: number = 1, pageSize: number = 20): Observable<VideoSearchResponse> {
    const params = {
      user_query: query,
      page: page,
      page_size: pageSize,
    };

    return this.http
      .get<any>(`${this.API_BASE_URL}/VideoSearch`, { params })
      .pipe(
        map((response) => {
          if (response.code === 200 && response.result) {
            const results = response.result.map((item: any) => ({
              id: item.video_path,
              path: item.video_path,
              similarity: (item.score * 100).toFixed(2),
              timestamps: item.timestamps || [],
              frameNumbers: item.frame_numbers || [],
            }));

            return {
              results,
              pagination: response.pagination || {
                page,
                page_size: pageSize,
                total_count: results.length,
                total_pages: 1,
                has_next: false,
                has_prev: false,
              },
            };
          }

          return {
            results: [],
            pagination: {
              page,
              page_size: pageSize,
              total_count: 0,
              total_pages: 0,
              has_next: false,
              has_prev: false,
            },
          };
        }),
        catchError((error) => {
          console.error('Video search error:', error);
          return throwError(() => this.handleError(error));
        }),
      );
  }

  private handleError(error: any): Error {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new Error('请求超时，请检查网络连接或稍后重试');
    }
    if (error.message?.includes('Network Error')) {
      return new Error('网络连接失败，请检查网络设置');
    }
    return new Error('搜索失败：' + (error.message || '未知错误'));
  }
}
