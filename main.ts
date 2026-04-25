import {
	App,
	ItemView,
	MarkdownRenderer,
	Notice,
	Plugin,
	TFile,
	ViewStateResult,
	WorkspaceLeaf
} from "obsidian";

const VIEW_TYPE_ARKIDIAN = "arkidian-canvas-view";
const META_SUFFIX = ".meta.json";
const DEFAULT_CARD_WIDTH = 380;
const DEFAULT_CARD_HEIGHT = 320;

type CanvasItemState = {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
};

type CanvasMeta = {
	version: 1;
	zoom: number;
	items: Record<string, CanvasItemState>;
};

type SectionNode = {
	id: string;
	title: string;
	level: number;
	path: string[];
	startLine: number;
	endLine: number;
	content: string;
};

type OrphanNode = {
	id: string;
	content: string;
	startLine: number;
	endLine: number;
};

type ParsedDocument = {
	sections: SectionNode[];
	orphans: OrphanNode[];
	topLevel: number | null;
};

type ArkidianViewState = {
	file?: string;
};

export default class ArkidianPlugin extends Plugin {
	async onload() {
		this.registerView(
			VIEW_TYPE_ARKIDIAN,
			(leaf) => new ArkidianView(leaf, this)
		);

		this.addRibbonIcon("layout-dashboard", "Open Arkidian Canvas", async () => {
			await this.activateView();
		});

		this.addCommand({
			id: "open-arkidian-canvas",
			name: "Open current file in Arkidian Canvas",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
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

	async activateView(file?: TFile) {
		const leaf =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_ARKIDIAN)[0] ??
			this.app.workspace.getRightLeaf(false);

		if (!leaf) {
			new Notice("Could not open Arkidian view.");
			return;
		}

		await leaf.setViewState({
			type: VIEW_TYPE_ARKIDIAN,
			active: true,
			state: {
				file: (file ?? this.app.workspace.getActiveFile())?.path
			}
		});
		this.app.workspace.revealLeaf(leaf);
	}
}

class ArkidianView extends ItemView {
	private plugin: ArkidianPlugin;
	private currentFile: TFile | null = null;
	private canvasEl!: HTMLDivElement;
	private stageEl!: HTMLDivElement;
	private zoom = 1;
	private saveTimers = new Map<string, number>();

	constructor(leaf: WorkspaceLeaf, plugin: ArkidianPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_ARKIDIAN;
	}

	getDisplayText() {
		return "Arkidian Canvas";
	}

	getIcon() {
		return "layout-dashboard";
	}

	async onOpen() {
		this.containerEl.empty();
		this.containerEl.addClass("arkidian-view");

		const toolbar = this.containerEl.createDiv({ cls: "arkidian-toolbar" });
		const refreshButton = toolbar.createEl("button", { text: "Refresh" });
		refreshButton.addEventListener("click", () => {
			void this.renderCurrentFile();
		});

		const openActiveButton = toolbar.createEl("button", {
			text: "Use Active File"
		});
		openActiveButton.addEventListener("click", async () => {
			const file = this.app.workspace.getActiveFile();
			if (!file || file.extension !== "md") {
				new Notice("Active file is not a markdown file.");
				return;
			}
			this.currentFile = file;
			await this.renderCurrentFile();
		});

		this.canvasEl = this.containerEl.createDiv({ cls: "arkidian-canvas" });
		this.stageEl = this.canvasEl.createDiv({ cls: "arkidian-stage" });

		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (this.currentFile && file.path === this.currentFile.path) {
					await this.renderCurrentFile();
				}
			})
		);

		await this.restoreFileFromState();
		await this.renderCurrentFile();
	}

	async setState(state: ArkidianViewState, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		this.currentFile = state.file
			? this.app.vault.getAbstractFileByPath(state.file) instanceof TFile
				? (this.app.vault.getAbstractFileByPath(state.file) as TFile)
				: null
			: null;
	}

	getState(): ArkidianViewState {
		return {
			file: this.currentFile?.path
		};
	}

	private async restoreFileFromState() {
		if (this.currentFile) {
			return;
		}

		const active = this.app.workspace.getActiveFile();
		if (active?.extension === "md") {
			this.currentFile = active;
		}
	}

	private async renderCurrentFile() {
		this.stageEl.empty();

		if (!this.currentFile) {
			this.renderEmptyState("Open a markdown file to populate the canvas.");
			return;
		}

		const source = await this.app.vault.read(this.currentFile);
		const parsed = parseMarkdownStructure(source);
		const meta = await this.readMeta(this.currentFile);
		this.zoom = meta.zoom || 1;
		this.stageEl.style.transform = `scale(${this.zoom})`;

		if (!parsed.sections.length && !parsed.orphans.length) {
			this.renderEmptyState("This document has no visible markdown blocks yet.");
			return;
		}

		parsed.sections.forEach((section, index) => {
			const fallback = this.getDefaultItemState(section.id, index, false);
			const state = meta.items[section.id] ?? fallback;
			this.renderSectionCard(section, state);
		});

		parsed.orphans.forEach((orphan, index) => {
			const fallback = this.getDefaultItemState(orphan.id, index, true);
			const state = meta.items[orphan.id] ?? fallback;
			this.renderOrphan(orphan, state);
		});

		await this.writeMeta({
			...meta,
			items: {
				...Object.fromEntries(
					[...parsed.sections, ...parsed.orphans].map((node, index) => {
						const fallback = this.getDefaultItemState(
							node.id,
							index,
							"id" in node && node.id.startsWith("orphan")
						);
						return [node.id, meta.items[node.id] ?? fallback];
					})
				)
			}
		});
	}

	private renderEmptyState(message: string) {
		const empty = this.stageEl.createDiv({ cls: "arkidian-empty" });
		empty.setText(message);
	}

	private renderSectionCard(section: SectionNode, state: CanvasItemState) {
		const card = this.stageEl.createDiv({ cls: "arkidian-card" });
		applyItemFrame(card, state);

		const body = card.createDiv({ cls: "arkidian-card-body" });
		const preview = body.createDiv({ cls: "arkidian-preview" });
		void this.renderMarkdownPreview(preview, section.content);

		this.enableDragging(card, card, section.id, state);
	}

	private renderOrphan(orphan: OrphanNode, state: CanvasItemState) {
		const item = this.stageEl.createDiv({ cls: "arkidian-orphan" });
		applyItemFrame(item, state);

		const body = item.createDiv({ cls: "arkidian-orphan-body" });
		body.setText(orphan.content.trim());

		this.enableDragging(item, item, orphan.id, state);
	}

	private enableDragging(
		target: HTMLElement,
		handle: HTMLElement,
		itemId: string,
		state: CanvasItemState
	) {
		let startX = 0;
		let startY = 0;
		let originX = state.x;
		let originY = state.y;

		const onPointerMove = (event: PointerEvent) => {
			const deltaX = (event.clientX - startX) / this.zoom;
			const deltaY = (event.clientY - startY) / this.zoom;
			state.x = originX + deltaX;
			state.y = originY + deltaY;
			applyItemFrame(target, state);
		};

		const onPointerUp = () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			void this.persistItemState(itemId, state);
		};

		handle.addEventListener("pointerdown", (event) => {
			startX = event.clientX;
			startY = event.clientY;
			originX = state.x;
			originY = state.y;
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", onPointerUp);
		});
	}

	private queueSectionSave(section: SectionNode, nextContent: string) {
		const existing = this.saveTimers.get(section.id);
		if (existing) {
			window.clearTimeout(existing);
		}

		const timer = window.setTimeout(() => {
			void this.saveSection(section, nextContent);
		}, 500);

		this.saveTimers.set(section.id, timer);
	}

	private async saveSection(section: SectionNode, nextContent: string) {
		if (!this.currentFile) {
			return;
		}

		const latest = await this.app.vault.read(this.currentFile);
		const lines = latest.split(/\r?\n/);
		const replacement = nextContent.replace(/\r\n/g, "\n").split("\n");
		const nextLines = [
			...lines.slice(0, section.startLine),
			...replacement,
			...lines.slice(section.endLine + 1)
		];

		await this.app.vault.modify(this.currentFile, nextLines.join("\n"));
	}

	private async renderMarkdownPreview(container: HTMLElement, markdown: string) {
		container.empty();
		if (!this.currentFile) {
			return;
		}
		await MarkdownRenderer.render(
			this.app,
			markdown,
			container,
			this.currentFile.path,
			this
		);
	}

	private getMetaPath(file: TFile) {
		const parent = file.parent?.path;
		const base = `${file.basename}${META_SUFFIX}`;
		return parent ? `${parent}/${base}` : base;
	}

	private async readMeta(file: TFile): Promise<CanvasMeta> {
		const metaPath = this.getMetaPath(file);
		const existing = this.app.vault.getAbstractFileByPath(metaPath);
		if (!(existing instanceof TFile)) {
			return {
				version: 1,
				zoom: 1,
				items: {}
			};
		}

		try {
			return JSON.parse(await this.app.vault.read(existing)) as CanvasMeta;
		} catch {
			new Notice("Could not parse Arkidian metadata. Resetting layout.");
			return {
				version: 1,
				zoom: 1,
				items: {}
			};
		}
	}

	private async writeMeta(meta: CanvasMeta) {
		if (!this.currentFile) {
			return;
		}

		const metaPath = this.getMetaPath(this.currentFile);
		const existing = this.app.vault.getAbstractFileByPath(metaPath);
		const payload = JSON.stringify(meta, null, 2);

		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, payload);
		} else {
			await this.app.vault.create(metaPath, payload);
		}
	}

	private async persistItemState(itemId: string, state: CanvasItemState) {
		if (!this.currentFile) {
			return;
		}
		const meta = await this.readMeta(this.currentFile);
		meta.items[itemId] = state;
		meta.zoom = this.zoom;
		await this.writeMeta(meta);
	}

	private getDefaultItemState(
		id: string,
		index: number,
		isOrphan: boolean
	): CanvasItemState {
		return {
			id,
			x: isOrphan ? 40 : 80 + (index % 3) * 420,
			y: isOrphan ? 80 + index * 180 : 60 + Math.floor(index / 3) * 360,
			width: DEFAULT_CARD_WIDTH,
			height: isOrphan ? 140 : DEFAULT_CARD_HEIGHT
		};
	}
}

function parseMarkdownStructure(markdown: string): ParsedDocument {
	const lines = markdown.split(/\r?\n/);
	const headingMatches = lines
		.map((line, index) => {
			const match = /^(#{1,6})\s+(.*)$/.exec(line);
			return match
				? {
						index,
						level: match[1].length,
						title: match[2].trim()
					}
				: null;
		})
		.filter(Boolean) as Array<{ index: number; level: number; title: string }>;

	if (!headingMatches.length) {
		return {
			sections: [],
			orphans: collectOrphans(lines, 0, lines.length - 1),
			topLevel: null
		};
	}

	const topLevel = Math.min(...headingMatches.map((heading) => heading.level));
	const topHeadings = headingMatches.filter((heading) => heading.level === topLevel);
	const sections: SectionNode[] = topHeadings.map((heading, idx) => {
		const next = topHeadings[idx + 1];
		const endLine = next ? next.index - 1 : lines.length - 1;
		const content = lines.slice(heading.index, endLine + 1).join("\n");
		return {
			id: `section:${buildSectionPath(lines, heading.index).join(" > ")}`,
			title: heading.title,
			level: heading.level,
			path: buildSectionPath(lines, heading.index),
			startLine: heading.index,
			endLine,
			content
		};
	});

	const firstTopIndex = topHeadings[0]?.index ?? 0;
	const orphans = collectOrphans(lines, 0, firstTopIndex - 1);

	return {
		sections,
		orphans,
		topLevel
	};
}

function buildSectionPath(lines: string[], headingIndex: number): string[] {
	const path: Array<{ level: number; title: string }> = [];
	for (let index = 0; index <= headingIndex; index += 1) {
		const match = /^(#{1,6})\s+(.*)$/.exec(lines[index]);
		if (!match) {
			continue;
		}
		const level = match[1].length;
		const title = match[2].trim();
		while (path.length && path[path.length - 1].level >= level) {
			path.pop();
		}
		path.push({ level, title });
	}
	return path.map((entry) => entry.title);
}

function collectOrphans(lines: string[], start: number, end: number): OrphanNode[] {
	if (end < start) {
		return [];
	}

	const content = lines.slice(start, end + 1).join("\n").trim();
	if (!content) {
		return [];
	}

	return [
		{
			id: "orphan:root",
			content,
			startLine: start,
			endLine: end
		}
	];
}

function applyItemFrame(element: HTMLElement, state: CanvasItemState) {
	element.style.left = `${state.x}px`;
	element.style.top = `${state.y}px`;
	element.style.width = `${state.width}px`;
	element.style.minHeight = `${state.height}px`;
}
