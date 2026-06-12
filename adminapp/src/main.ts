import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import { branding } from "../../branding.js";

document.title = `${branding.name} Admin`;
createApp(App).mount("#app");
