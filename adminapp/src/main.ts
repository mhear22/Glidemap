import { createApp } from "vue";
import App from "./App.vue";
import "../../shared/tokens.css";
import "./styles.css";
import { branding } from "../../branding.js";

document.title = `${branding.name} Admin`;

// Honour the saved theme (shared with the webapp via localStorage 'theme').
const savedTheme = localStorage.getItem("theme");
document.documentElement.setAttribute("data-theme", savedTheme === "light" ? "light" : "dark");

createApp(App).mount("#app");
