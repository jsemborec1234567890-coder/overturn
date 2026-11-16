import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/canvas.ts",
    capture: "src/capture.ts",
  },
  format: ["esm"],
  platform: "neutral",
  target: "es2022",
  splitting: false,
  dts: true,
  sourcemap: false,
  clean: true,
  outDir: "dist",
});
