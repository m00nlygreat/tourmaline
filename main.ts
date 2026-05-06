import {
	addIcon,
	MarkdownView,
	Notice,
	Plugin,
	TFile
} from "obsidian";
import { META_SUFFIX, TOURMALINE_ICON, TOURMALINE_ICON_SVG, VIEW_TYPE_ARKIDIAN } from "./src/constants";
import { ArkidianView } from "./src/view";

export default class ArkidianPlugin extends Plugin {
	async onload() {
		addIcon(TOURMALINE_ICON, TOURMALINE_ICON_SVG);

		this.registerView(
			VIEW_TYPE_ARKIDIAN,
			(leaf) => new ArkidianView(leaf)
		);

		this.addRibbonIcon(TOURMALINE_ICON, "Open Tourmaline", async () => {
			await this.activateView(this.getCurrentViewedMarkdownFile());
		});

		this.addCommand({
			id: "open-arkidian-canvas",
			name: "Open current file in Tourmaline",
			hotkeys: [
				{
					modifiers: ["Mod", "Shift"],
					key: "E"
				}
			],
			checkCallback: (checking) => {
				const file = this.getCurrentViewedMarkdownFile();
				if (!file || file.extension !== "md") {
					return false;
				}

				if (!checking) {
					void this.activateView(file);
				}

				return true;
			}
		});

		this.addCommand({
			id: "delete-all-arkidian-metadata",
			name: "Delete all Tourmaline metadata files",
			callback: async () => {
				await this.deleteAllMetadataFiles();
			}
		});

		this.registerExtensions(["meta.json"], VIEW_TYPE_ARKIDIAN);
	}

	async onunload() {
		await this.app.workspace.detachLeavesOfType(VIEW_TYPE_ARKIDIAN);
	}

	async activateView(file?: TFile | null) {
		const targetFile = file ?? this.getCurrentViewedMarkdownFile();
		const leaf = this.app.workspace.getLeaf("tab");

		if (!leaf) {
			new Notice("Could not open Arkidian view.");
			return;
		}

		await leaf.setViewState({
			type: VIEW_TYPE_ARKIDIAN,
			active: true,
			state: {
				file: targetFile?.path
			}
		});
		this.app.workspace.revealLeaf(leaf);
	}

	private async deleteAllMetadataFiles() {
		const metadataFiles = this.app.vault
			.getFiles()
			.filter((file) => file.path.endsWith(META_SUFFIX));

		if (metadataFiles.length === 0) {
			new Notice("No Tourmaline metadata files found.");
			return;
		}

		let deletedCount = 0;
		let failedCount = 0;

		for (const file of metadataFiles) {
			try {
				await this.app.vault.delete(file, true);
				deletedCount += 1;
			} catch {
				failedCount += 1;
			}
		}

		if (failedCount > 0) {
			new Notice(`Deleted ${deletedCount} Tourmaline metadata files. Failed to delete ${failedCount}.`);
			return;
		}

		new Notice(`Deleted ${deletedCount} Tourmaline metadata files.`);
	}

	private getCurrentViewedMarkdownFile() {
		const activeView = this.app.workspace.activeLeaf?.view;
		if (activeView instanceof ArkidianView) {
			return activeView.getCurrentFile();
		}
		if (activeView instanceof MarkdownView && activeView.file?.extension === "md") {
			return activeView.file;
		}

		const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeMarkdownView?.file?.extension === "md") {
			return activeMarkdownView.file;
		}

		const activeFile = this.app.workspace.getActiveFile();
		return activeFile?.extension === "md" ? activeFile : null;
	}
}
