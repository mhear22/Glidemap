process.env["MAPANIM_SERVE_UI"] = "0";
process.env["PORT"] ??= process.env["MAPANIM_API_PORT"] ?? "4822";

await import("../server/index.js");
