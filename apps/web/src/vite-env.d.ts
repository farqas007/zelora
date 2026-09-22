/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute base URL of the Zelora API (no trailing slash). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}