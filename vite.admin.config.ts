import { createFrontendViteConfig } from "./vite.shared.js";

export default createFrontendViteConfig({
  root: "adminapp",
  defaultPort: 5174,
  portEnv: "MAPANIM_ADMIN_PORT"
});
