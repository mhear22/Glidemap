/// <reference types="vite/client" />

// Injected by vite.shared.ts from the package.json version.
declare const __APP_VERSION__: string;

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
