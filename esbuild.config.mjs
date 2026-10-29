import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["src/main.ts"],
	bundle: true,
	outfile: "main.js",
	format: "cjs",
	platform: "node",
	target: "es2020",
	external: ["obsidian", "electron"],
	logLevel: "info",
	treeShaking: true,
});
