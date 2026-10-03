import type { FlameApi } from '@shared/types';

declare global {
  interface Window {
    flame?: FlameApi;
  }
}

export {};
