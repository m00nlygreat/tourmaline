import {
	addIcon,
	MarkdownView,
	Notice,
	Plugin,
	TFile
} from "obsidian";
import { TOURMALINE_ICON, TOURMALINE_ICON_SVG, VIEW_TYPE_ARKIDIAN } from "./src/constants";
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