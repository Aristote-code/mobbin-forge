import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const { outputFiles } = await build({
  entryPoints: ["src/ui/gallery.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});
const html = await readFile("src/ui/gallery.html", "utf8");
await mkdir("dist/ui", { recursive: true });
await writeFile(
  "dist/ui/gallery.html",
  html.replace("/* GALLERY_SCRIPT */", () =>
    outputFiles[0].text.replaceAll("</script", "<\\/script"),
  ),
);
