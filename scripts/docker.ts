import path from "node:path";
import {
  ensureLocalDockerDirs,
  mountPathSuffix,
  resolveContainerEngine,
  rootDir,
  run
} from "./docker-lib.js";

const containerEngine = resolveContainerEngine();
const imageRef = "mapanim:local";
const suffix = mountPathSuffix(containerEngine);

ensureLocalDockerDirs();

console.log(`Building ${imageRef}`);
run(containerEngine, ["build", "--tag", imageRef, "--file", "Dockerfile", "."]);

console.log(`Running ${imageRef}`);
run(containerEngine, [
  "run",
  "--rm",
  "--name",
  "mapanim",
  "--ipc=host",
  "-p",
  "5173:5173",
  "-p",
  "5174:5174",
  "-v",
  `${path.join(rootDir, "output")}:/app/output${suffix}`,
  "-v",
  `${path.join(rootDir, "presets")}:/app/presets${suffix}`,
  "-v",
  `${path.join(rootDir, "routes.json")}:/app/routes.json${suffix}`,
  imageRef
]);
