export type BrowserAction =
  | { type: 'navigate'; url: string; page?: 0 | 1 }
  | { type: 'click'; selector: string; page?: 0 | 1 }
  | { type: 'fill'; selector: string; value: string; page?: 0 | 1 }
  | { type: 'press'; key: string; page?: 0 | 1 }
  | { type: 'screenshot' | 'console' | 'errors' | 'failedRequests'; page?: 0 | 1 }
  | { type: 'download'; id: string; page?: 0 | 1 };

export interface TaskPolicy {
  previewOrigin: string;
  expiresAt: number;
  publicDomains?: string[];
  allowLoopbackPreview?: boolean;
}

export interface CreateTaskRequest { policy: TaskPolicy }
export interface TaskResponse { id: string; expiresAt: number }
export interface Capabilities {
  mode: 'policy-control-foundation';
  browserExecution: false;
  networkBoundary: false;
  reason: string;
}
