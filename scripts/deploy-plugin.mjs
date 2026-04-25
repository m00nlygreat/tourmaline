import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const distDir = resolve(projectRoot, "dist");
const targetDir = process.env.OBSIDIAN_PLUGIN_DIR
	? resolve(process.env.OBSIDIAN_PLUGIN_DIR)
	: "D:\\vault\\.obsidian\\plugins\\arkidian";

const assets = ["main.js", "manifest.json", "styles.css"];

mkdirSync(targetDir, { recursive: true });

for (const asset of assets) {
	const source = resolve(distDir, asset);
	const destination = resolve(targetDir, asset);

	if (!existsSync(source)) {
		throw new Error(`Missing build artifact: ${source}`);
	}

	copyFileSync(source, destination);
	console.log(`Copied ${asset} -> ${destination}`);
}
