import {
	App,
	getFrontMatterInfo,
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	Plugin,
	setIcon,
	TFile,
	ViewStateResult,
	WorkspaceLeaf
} from "obsidian";
import type { MetadataCache } from "obsidian";
import type { Content, Heading, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";

const VIEW_TYPE_ARKIDIAN = "arkidian-canvas-view";
const META_SUFFIX = ".meta.json";
const DEFAULT_CARD_WIDTH = 380;
const DEFAULT_CARD_HEIGHT = 320;
const STAGE_WIDTH = 14000;
const STAGE_HEIGHT = 9000;
const MIN_CARD_WIDTH = 240;
const MAX_CARD_WIDTH = 1200;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;
const MIN_SCROLLABLE_OVERFLOW = 2;
const GRID_SPACING = 28;
const GRID_DOT_RADIUS = 0.9;
const MIN_GRID_SCREEN_SPACING = 14;

type CanvasItemState = {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
};

type CanvasMeta = {
	version: 2;
	scopes: Record<
		string,
		{
			zoom: number;
			items: Record<string, CanvasItemState>;
		}
	>;
};

type SectionNode = {
	id: string;
	title: string;
	level: number;
	path: string[];
	startLine: number;
	endLine: number;
	content: string;
	scopeId: string;
};

type OrphanNode = {
	id: string;
	content: string;
	startLine: number;
	endLine: number;
	scopeId: string;
	childScopeId?: string;
};

type ParsedScope = {
	id: string;
	title: string;
	startLine: number;
	endLine: number;
	depth: number | null;
	sections: SectionNode[];
	orphans: OrphanNode[];
};

type ParsedDocument = {
	scopes: Record<string, ParsedScope>;
	rootScopeId: string;
	maxHeadingDepth: number;
};

type ArkidianViewState = {
	file?: string;
	scopeId?: string;
};

type FrontmatterTableRow = {
	key: string;
	value: string;
};

type FrontmatterItem = {
	id: string;
	scopeId: string;
	rows: FrontmatterTableRow[];
};

type RenderableScopeItem =
	| {
			kind: "frontmatter";
			id: string;
			startLine: number;
			item: FrontmatterItem;
	  }
	| {
			kind: "section";
			id: string;
			startLine: number;
			item: SectionNode;
	  }
	| {
			kind: "orphan";
			id: string;
			startLine: number;
			item: OrphanNode;
	  };

type LayerTreeNode = {
	id: string;
	label: string;
	icon: string;
	kind: "frontmatter" | "section" | "orphan";
	startLine: number;
	targetScopeId?: string;
	openLine?: number;
	children: LayerTreeNode[];
};

type ZoomPluginApi = {
	zoomIn(editor: EditorLike, line: number): void;
};

type EditorLike = {
	setCursor(pos: { line: number; ch: number }): void;
	scrollIntoView(range: { from: { line: number; ch: number }; to?: { line: number; ch: number } }, center?: boolean): void;
};

declare global {
	interface Window {
		ObsidianZoomPlugin?: ZoomPluginApi;
	}
}

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
		const leaf = this.app.workspace.getLeaf("tab");

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
	private currentScopeId = "scope:root";
	private parsedDocument: ParsedDocument | null = null;
	private toolbarBreadcrumbsEl!: HTMLDivElement;
	private toolbarActionsEl!: HTMLDivElement;
	private backButtonEl!: HTMLDivElement;
	private workspaceEl!: HTMLDivElement;
	private layerPanelEl!: HTMLDivElement;
	private layerTreeEl!: HTMLDivElement;
	private canvasEl!: HTMLDivElement;
	private scrollEl!: HTMLDivElement;
	private gridCanvasEl!: HTMLCanvasElement;
	private stageViewportEl!: HTMLDivElement;
	private stageEl!: HTMLDivElement;
	private zoom = 1;
	private viewportOffsetX = 0;
	private viewportOffsetY = 0;
	private saveTimers = new Map<string, number>();
	private zoomSaveTimer: number | null = null;
	private suppressFileRefreshUntil = 0;
	private isSpacePressed = false;
	private fittedFilePath: string | null = null;
	private fittedScopeId: string | null = null;
	private gridRenderFrame: number | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private expandedLayerIds = new Set<string>();
	private selectedItemId: string | null = null;
	private selectedItemEl: HTMLElement | null = null;

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
		this.toolbarBreadcrumbsEl = toolbar.createDiv({
			cls: "arkidian-toolbar-breadcrumbs"
		});
		this.toolbarActionsEl = toolbar.createDiv({ cls: "arkidian-toolbar-actions" });
		this.backButtonEl = createInteractiveControl(this.toolbarActionsEl, {
			cls: "arkidian-toolbar-control",
			text: "Back"
		});
		this.backButtonEl.addEventListener("click", () => {
			if (!this.parsedDocument) {
				return;
			}
			const parentScopeId = getParentScopeId(this.currentScopeId);
			if (!parentScopeId || !this.parsedDocument.scopes[parentScopeId]) {
				return;
			}
			this.currentScopeId = parentScopeId;
			this.fittedScopeId = null;
			void this.renderCurrentFile();
		});
		const refreshButton = createInteractiveControl(this.toolbarActionsEl, {
			cls: "arkidian-toolbar-control",
			text: "Refresh"
		});
		refreshButton.addEventListener("click", () => {
			this.fittedFilePath = null;
			this.fittedScopeId = null;
			void this.renderCurrentFile();
		});

		const openActiveButton = createInteractiveControl(this.toolbarActionsEl, {
			cls: "arkidian-toolbar-control",
			text: "Use Active File"
		});
		openActiveButton.addEventListener("click", async () => {
			const file = this.app.workspace.getActiveFile();
			if (!file || file.extension !== "md") {
				new Notice("Active file is not a markdown file.");
				return;
			}
			this.currentFile = file;
			this.fittedFilePath = null;
			this.currentScopeId = "scope:root";
			this.fittedScopeId = null;
			await this.renderCurrentFile();
		});

		this.workspaceEl = this.containerEl.createDiv({ cls: "arkidian-workspace" });
		this.layerPanelEl = this.workspaceEl.createDiv({ cls: "arkidian-layer-panel" });
		const layerPanelHeader = this.layerPanelEl.createDiv({
			cls: "arkidian-layer-panel-header"
		});
		layerPanelHeader.createSpan({
			cls: "arkidian-layer-panel-eyebrow",
			text: "Layers"
		});
		this.layerTreeEl = this.layerPanelEl.createDiv({ cls: "arkidian-layer-tree" });
		this.canvasEl = this.workspaceEl.createDiv({ cls: "arkidian-canvas" });
		this.scrollEl = this.canvasEl.createDiv({ cls: "arkidian-scroll" });
		this.gridCanvasEl = this.canvasEl.createEl("canvas", {
			cls: "arkidian-grid-layer"
		});
		this.stageViewportEl = this.scrollEl.createDiv({
			cls: "arkidian-stage-viewport"
		});
		this.stageEl = this.stageViewportEl.createDiv({ cls: "arkidian-stage" });
		this.syncStageZoom();
		this.scrollEl.addEventListener("wheel", (event) => {
			this.handleCanvasWheel(event);
		});
		this.scrollEl.addEventListener("scroll", () => {
			this.scheduleGridRender();
		});
		this.resizeObserver = new ResizeObserver(() => {
			this.enforceZoomBounds();
			this.normalizeViewportPresentation();
			this.scheduleGridRender();
		});
		this.resizeObserver.observe(this.canvasEl);
		this.registerDomEvent(window, "keydown", (event: KeyboardEvent) => {
			if (event.code === "Space") {
				if (!isTypingTarget(event.target)) {
					event.preventDefault();
				}
				this.isSpacePressed = true;
				this.scrollEl.addClass("is-space-panning");
			}
		});
		this.registerDomEvent(window, "keyup", (event: KeyboardEvent) => {
			if (event.code === "Space") {
				if (!isTypingTarget(event.target)) {
					event.preventDefault();
				}
				this.isSpacePressed = false;
				this.scrollEl.removeClass("is-space-panning");
			}
		});
		this.registerDomEvent(window, "blur", () => {
			this.isSpacePressed = false;
			this.scrollEl.removeClass("is-space-panning");
		});
		this.enableCanvasPanning();

		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (this.currentFile && file.path === this.currentFile.path) {
					if (Date.now() < this.suppressFileRefreshUntil) {
						return;
					}
					await this.renderCurrentFile();
				}
			})
		);

		await this.restoreFileFromState();
		await this.renderCurrentFile();
	}

	async onClose() {
		if (this.gridRenderFrame !== null) {
			window.cancelAnimationFrame(this.gridRenderFrame);
			this.gridRenderFrame = null;
		}
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	async setState(state: ArkidianViewState, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		this.currentFile = state.file
			? this.app.vault.getAbstractFileByPath(state.file) instanceof TFile
				? (this.app.vault.getAbstractFileByPath(state.file) as TFile)
				: null
			: null;
		this.currentScopeId = state.scopeId ?? "scope:root";
	}

	getState(): ArkidianViewState {
		return {
			file: this.currentFile?.path,
			scopeId: this.currentScopeId
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
		this.clearSelectedItem();
		this.stageEl.empty();
		this.renderToolbar();

		if (!this.currentFile) {
			this.renderEmptyState("Open a markdown file to populate the canvas.");
			return;
		}

		const source = await this.app.vault.read(this.currentFile);
		const parsed = parseMarkdownStructure(source);
		this.parsedDocument = parsed;
		if (!parsed.scopes[this.currentScopeId]) {
			this.currentScopeId = parsed.rootScopeId;
		}
		const scope = parsed.scopes[this.currentScopeId];
		const scopeOrphans = this.getDisplayOrphans(scope);
		const layerPanelOrphans = this.getLayerPanelOrphans(scope);
		const frontmatterItem = this.getFrontmatterItem(scope);
		const renderableItems = this.getRenderableItems(scope, frontmatterItem, scopeOrphans);
		const layerPanelItems = this.getRenderableItems(
			scope,
			frontmatterItem,
			layerPanelOrphans
		);
		const meta = await this.readMeta(this.currentFile);
		const scopeMeta = this.getScopeMeta(meta, this.currentScopeId);
		const itemStates: CanvasItemState[] = [];
		this.renderToolbar(scope);
		this.renderLayerPanel(scope, layerPanelItems);

		if (!renderableItems.length) {
			this.renderEmptyState("This document has no visible markdown blocks yet.");
			this.fitViewportToOriginIfNeeded();
			return;
		}

		for (const [index, renderable] of renderableItems.entries()) {
			const fallback = this.getDefaultItemState(
				renderable.id,
				index,
				renderable.kind === "orphan" || renderable.kind === "frontmatter",
				renderable.kind === "frontmatter"
			);
			const state = scopeMeta.items[renderable.id] ?? fallback;
			itemStates.push(state);
			if (renderable.kind === "frontmatter") {
				await this.renderFrontmatterCard(renderable.item, state);
				continue;
			}
			if (renderable.kind === "section") {
				await this.renderSectionCard(renderable.item, state);
				continue;
			}
			await this.renderOrphan(renderable.item, state);
		}

		meta.scopes[this.currentScopeId] = {
			zoom: scopeMeta.zoom,
			items: {
				...Object.fromEntries(
					renderableItems.map((renderable, index) => {
						const fallback = this.getDefaultItemState(
							renderable.id,
							index,
							renderable.kind === "orphan" || renderable.kind === "frontmatter",
							renderable.kind === "frontmatter"
						);
						return [renderable.id, scopeMeta.items[renderable.id] ?? fallback];
					})
				)
			}
		};
		await this.writeMeta({
			...meta
		});

		this.fitViewportToItemsIfNeeded(itemStates, scopeMeta.zoom || 1);
	}

	private getDisplayOrphans(scope: ParsedScope): OrphanNode[] {
		if (!this.currentFile || scope.id !== "scope:root") {
			return scope.orphans;
		}

		return [createFileTitleOrphan(this.currentFile.basename), ...scope.orphans];
	}

	private getLayerPanelOrphans(scope: ParsedScope): OrphanNode[] {
		return this.getDisplayOrphans(scope).filter(
			(orphan) => !orphan.id.endsWith(":scope-heading")
		);
	}

	private getFrontmatterItem(scope: ParsedScope): FrontmatterItem | null {
		if (!this.currentFile || scope.id !== "scope:root") {
			return null;
		}

		const rows = Object.entries(
			this.getFrontmatterValues(this.currentFile, this.app.metadataCache)
		).map(([key, value]) => ({
			key,
			value: stringifyFrontmatterValue(value)
		}));

		return {
			id: "frontmatter:scope:root",
			scopeId: scope.id,
			rows
		};
	}

	private getRenderableItems(
		scope: ParsedScope,
		frontmatterItem: FrontmatterItem | null,
		scopeOrphans: OrphanNode[]
	): RenderableScopeItem[] {
		const renderableItems: RenderableScopeItem[] = [];
		if (frontmatterItem) {
			renderableItems.push({
				kind: "frontmatter",
				id: frontmatterItem.id,
				startLine: -2,
				item: frontmatterItem
			});
		}

		for (const section of scope.sections) {
			renderableItems.push({
				kind: "section",
				id: section.id,
				startLine: section.startLine,
				item: section
			});
		}

		for (const orphan of scopeOrphans) {
			renderableItems.push({
				kind: "orphan",
				id: orphan.id,
				startLine:
					orphan.id === "orphan:scope:root:file-title" ? -1 : orphan.startLine,
				item: orphan
			});
		}

		return renderableItems.sort((a, b) => {
			if (a.startLine !== b.startLine) {
				return a.startLine - b.startLine;
			}
			return getRenderableKindPriority(a.kind) - getRenderableKindPriority(b.kind);
		});
	}

	private renderLayerPanel(scope: ParsedScope, renderableItems: RenderableScopeItem[]) {
		this.layerTreeEl.empty();

		const scopeHeader = this.layerTreeEl.createDiv({
			cls: "arkidian-layer-scope-header"
		});
		scopeHeader.createSpan({
			cls: "arkidian-layer-scope-title",
			text: scope.id === "scope:root" ? this.currentFile?.basename ?? "Document" : scope.title
		});
		scopeHeader.createSpan({
			cls: "arkidian-layer-scope-meta",
			text: `${renderableItems.length} items`
		});

		const tree = this.buildLayerTree(scope.id);
		if (!tree.length) {
			this.layerTreeEl.createDiv({
				cls: "arkidian-layer-empty",
				text: "No visible layers."
			});
			return;
		}

		this.renderLayerTreeNodes(tree, this.layerTreeEl, 0);
	}

	private rerenderCurrentLayerPanel() {
		if (!this.parsedDocument) {
			return;
		}

		const scope = this.parsedDocument.scopes[this.currentScopeId];
		if (!scope) {
			return;
		}

		this.renderLayerPanel(
			scope,
			this.getRenderableItems(
				scope,
				this.getFrontmatterItem(scope),
				this.getLayerPanelOrphans(scope)
			)
		);
	}

	private buildLayerTree(scopeId: string): LayerTreeNode[] {
		if (!this.parsedDocument) {
			return [];
		}

		const scope = this.parsedDocument.scopes[scopeId];
		if (!scope) {
			return [];
		}

		const renderableItems = this.getRenderableItems(
			scope,
			this.getFrontmatterItem(scope),
			this.getLayerPanelOrphans(scope)
		);

		return renderableItems.map((renderable) => {
			if (renderable.kind === "frontmatter") {
				return {
					id: renderable.id,
					label: "Properties",
					icon: "sliders-horizontal",
					kind: renderable.kind,
					startLine: renderable.startLine,
					openLine: 0,
					children: []
				};
			}

			if (renderable.kind === "section") {
				return {
					id: renderable.id,
					label: renderable.item.title,
					icon: getHeadingIcon(renderable.item.level),
					kind: renderable.kind,
					startLine: renderable.startLine,
					targetScopeId: renderable.item.scopeId,
					openLine: renderable.item.startLine,
					children: this.buildLayerTree(renderable.item.scopeId)
				};
			}

			return {
				id: renderable.id,
				label: getOrphanLayerLabel(renderable.item),
				icon: getOrphanLayerIcon(renderable.item),
				kind: renderable.kind,
				startLine: renderable.startLine,
				targetScopeId: renderable.item.childScopeId,
				openLine: renderable.item.startLine,
				children: renderable.item.childScopeId
					? this.buildLayerTree(renderable.item.childScopeId)
					: []
			};
		});
	}

	private renderLayerTreeNodes(
		nodes: LayerTreeNode[],
		container: HTMLElement,
		depth: number
	) {
		for (const node of nodes) {
			const item = container.createDiv({ cls: "arkidian-layer-item" });
			const row = item.createDiv({
				cls: "arkidian-layer-row"
			});
			row.style.setProperty("--arkidian-layer-depth", `${depth}`);
			row.toggleClass("is-current-scope", node.targetScopeId === this.currentScopeId);
			row.toggleClass("is-drillable", Boolean(node.targetScopeId));
			row.toggleClass("is-selected", node.id === this.selectedItemId);

			const isExpanded =
				node.children.length > 0 && this.expandedLayerIds.has(node.id);

			const toggle = createInteractiveControl(row, {
				cls: "arkidian-layer-toggle",
				label: isExpanded ? "Collapse layer" : "Expand layer"
			});
			if (node.children.length) {
				setIcon(toggle, isExpanded ? "chevron-down" : "chevron-right");
				toggle.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					if (isExpanded) {
						this.expandedLayerIds.delete(node.id);
					} else {
						this.expandedLayerIds.add(node.id);
					}
					this.rerenderCurrentLayerPanel();
				});
			} else {
				toggle.addClass("is-placeholder");
				toggle.setText("");
				setInteractiveDisabled(toggle, true);
			}

			const iconEl = row.createSpan({
				cls: "arkidian-layer-glyph"
			});
			setIcon(iconEl, node.icon);

			const labelButton = createInteractiveControl(row, {
				cls: "arkidian-layer-label-button",
				label: node.label
			});
			labelButton.createSpan({
				cls: "arkidian-layer-label",
				text: node.label
			});
			if (node.children.length) {
				labelButton.createSpan({
					cls: "arkidian-layer-children-count",
					text: `${node.children.length}`
				});
			}

			labelButton.addEventListener("click", (event) => {
				this.selectItemById(node.id);
				if (event.metaKey || event.ctrlKey) {
					if (
						node.targetScopeId &&
						this.parsedDocument?.scopes[node.targetScopeId]
					) {
						this.currentScopeId = node.targetScopeId;
						this.fittedScopeId = null;
						void this.renderCurrentFile();
					}
					return;
				}
				if (node.children.length && !isExpanded) {
					this.expandedLayerIds.add(node.id);
					this.rerenderCurrentLayerPanel();
				}
			});

			labelButton.addEventListener("dblclick", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (typeof node.openLine === "number") {
					void this.openSourceInPopout(node.openLine);
				}
			});

			if (node.children.length && isExpanded) {
				const children = item.createDiv({
					cls: "arkidian-layer-children"
				});
				this.renderLayerTreeNodes(node.children, children, depth + 1);
			}
		}
	}

	private renderToolbar(scope?: ParsedScope) {
		this.toolbarBreadcrumbsEl.empty();

		const rootLabel = this.currentFile?.basename ?? "Open markdown file";
		const rootButton = createInteractiveControl(this.toolbarBreadcrumbsEl, {
			cls: `arkidian-breadcrumb${this.currentScopeId === "scope:root" ? " is-current" : ""}`,
			text: rootLabel
		});
		setInteractiveDisabled(
			rootButton,
			!this.currentFile || this.currentScopeId === "scope:root"
		);
		rootButton.addEventListener("click", () => {
			if (!this.currentFile || this.currentScopeId === "scope:root") {
				return;
			}
			this.currentScopeId = "scope:root";
			this.fittedScopeId = null;
			void this.renderCurrentFile();
		});

		const pathSegments = getScopePathSegments(scope?.id ?? this.currentScopeId);
		pathSegments.forEach((segment, index) => {
			this.toolbarBreadcrumbsEl.createSpan({
				cls: "arkidian-breadcrumb-separator",
				text: "/"
			});
			const targetScopeId = `scope:${pathSegments.slice(0, index + 1).join(" > ")}`;
			const isCurrent = targetScopeId === this.currentScopeId;
			const crumb = createInteractiveControl(this.toolbarBreadcrumbsEl, {
				cls: `arkidian-breadcrumb${isCurrent ? " is-current" : ""}`,
				text: segment
			});
			setInteractiveDisabled(crumb, isCurrent);
			crumb.addEventListener("click", () => {
				if (isCurrent) {
					return;
				}
				this.currentScopeId = targetScopeId;
				this.fittedScopeId = null;
				void this.renderCurrentFile();
			});
		});

		setInteractiveDisabled(this.backButtonEl, this.currentScopeId === "scope:root");
	}

	private getFrontmatterValues(file: TFile, metadataCache: MetadataCache) {
		const cache = metadataCache.getFileCache(file)?.frontmatter;
		if (!cache) {
			return {};
		}

		return Object.fromEntries(
			Object.entries(cache).filter(([, value]) => typeof value !== "undefined")
		);
	}

	private async saveFrontmatterRow(row: FrontmatterTableRow, previousKey?: string) {
		if (!this.currentFile) {
			return;
		}

		if (!row.key) {
			new Notice("Property key is required.");
			return;
		}

		try {
			this.suppressFileRefreshUntil = Date.now() + 800;
			const parsedValue = parseFrontmatterValue(row.value);
			await this.app.fileManager.processFrontMatter(this.currentFile, (frontmatter) => {
				if (previousKey && previousKey !== row.key) {
					delete frontmatter[previousKey];
				}
				frontmatter[row.key] = parsedValue;
			});
		} catch (error) {
			console.error("Arkidian: failed to save frontmatter row", error);
			new Notice("Could not save this property.");
		}
	}

	private async deleteFrontmatterKey(key: string) {
		if (!this.currentFile) {
			return;
		}

		try {
			this.suppressFileRefreshUntil = Date.now() + 800;
			await this.app.fileManager.processFrontMatter(this.currentFile, (frontmatter) => {
				delete frontmatter[key];
			});
		} catch (error) {
			console.error("Arkidian: failed to delete frontmatter key", error);
			new Notice("Could not delete this property.");
		}
	}

	private renderEmptyState(message: string) {
		const empty = this.stageEl.createDiv({ cls: "arkidian-empty" });
		empty.setText(message);
	}

	private enableCanvasPanning() {
		let startX = 0;
		let startY = 0;
		let originScrollLeft = 0;
		let originScrollTop = 0;
		let isPanning = false;

		const onPointerMove = (event: PointerEvent) => {
			if (!isPanning) {
				return;
			}

			this.scrollEl.scrollLeft = originScrollLeft - (event.clientX - startX);
			this.scrollEl.scrollTop = originScrollTop - (event.clientY - startY);
		};

		const onPointerUp = () => {
			isPanning = false;
			this.scrollEl.removeClass("is-panning");
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
		};

		this.scrollEl.addEventListener("pointerdown", (event) => {
			if (
				event.target === this.scrollEl ||
				event.target === this.stageViewportEl ||
				event.target === this.stageEl
			) {
				this.clearSelectedItem();
			}

			const isSpaceDrag = this.isSpacePressed && event.button === 0;
			const isMiddleDrag = event.button === 1;
			if (!isSpaceDrag && !isMiddleDrag) {
				return;
			}

			event.preventDefault();
			isPanning = true;
			startX = event.clientX;
			startY = event.clientY;
			originScrollLeft = this.scrollEl.scrollLeft;
			originScrollTop = this.scrollEl.scrollTop;
			this.scrollEl.addClass("is-panning");
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", onPointerUp);
		});
		this.scrollEl.addEventListener("auxclick", (event) => {
			if (event.button === 1) {
				event.preventDefault();
			}
		});
	}

	private handleCanvasWheel(event: WheelEvent) {
		event.preventDefault();

		const zoomDelta = event.deltaY < 0 ? 1.1 : 1 / 1.1;
		const nextZoom = clamp(this.zoom * zoomDelta, this.getMinZoom(), MAX_ZOOM);
		if (nextZoom === this.zoom) {
			return;
		}

		const rect = this.scrollEl.getBoundingClientRect();
		const pointerX = event.clientX - rect.left;
		const pointerY = event.clientY - rect.top;
		const stagePoint = this.getStagePointFromViewport(pointerX, pointerY);

		this.zoom = nextZoom;
		this.syncStageZoom();
		this.anchorViewportOnStagePoint(stagePoint.x, stagePoint.y, pointerX, pointerY);
		this.queueZoomSave();
	}

	private syncStageZoom() {
		this.stageViewportEl.style.width = `${STAGE_WIDTH * this.zoom}px`;
		this.stageViewportEl.style.height = `${STAGE_HEIGHT * this.zoom}px`;
		this.stageEl.style.transform = `scale(${this.zoom})`;
		this.applyViewportOffset();
		this.scheduleGridRender();
	}

	private fitViewportToOriginIfNeeded() {
		if (
			!this.currentFile ||
			(this.fittedFilePath === this.currentFile.path &&
				this.fittedScopeId === this.currentScopeId)
		) {
			return;
		}

		this.runWhenCanvasReady(() => {
			this.zoom = 1;
			this.syncStageZoom();
			this.centerOnWorldPoint(0, 0);
			this.fittedFilePath = this.currentFile?.path ?? null;
			this.fittedScopeId = this.currentScopeId;
		});
	}

	private fitViewportToItemsIfNeeded(
		itemStates: CanvasItemState[],
		fallbackZoom: number
	) {
		if (
			!this.currentFile ||
			(this.fittedFilePath === this.currentFile.path &&
				this.fittedScopeId === this.currentScopeId)
		) {
			return;
		}

		this.runWhenCanvasReady(() => {
			const bounds = getItemBounds(itemStates);
			const viewportWidth = Math.max(1, this.scrollEl.clientWidth);
			const viewportHeight = Math.max(1, this.scrollEl.clientHeight);
			const padding = 140;
			const width = Math.max(bounds.maxX - bounds.minX, 1) + padding * 2;
			const height = Math.max(bounds.maxY - bounds.minY, 1) + padding * 2;
			const fitZoom = clamp(
				Math.min(viewportWidth / width, viewportHeight / height),
				this.getMinZoom(),
				MAX_ZOOM
			);

			this.zoom = Number.isFinite(fitZoom)
				? fitZoom
				: clamp(fallbackZoom, this.getMinZoom(), MAX_ZOOM);
			this.syncStageZoom();
			this.centerOnWorldPoint(bounds.centerX, bounds.centerY);
			this.fittedFilePath = this.currentFile?.path ?? null;
			this.fittedScopeId = this.currentScopeId;
		});
	}

	private centerOnWorldPoint(worldX: number, worldY: number) {
		const stageX = STAGE_WIDTH / 2 + worldX;
		const stageY = STAGE_HEIGHT / 2 + worldY;
		this.positionViewportAroundStagePoint(
			stageX,
			stageY,
			this.scrollEl.clientWidth / 2,
			this.scrollEl.clientHeight / 2
		);
		this.scheduleGridRender();
	}

	private runWhenCanvasReady(callback: () => void, attempts = 0) {
		window.requestAnimationFrame(() => {
			if (
				(this.scrollEl.clientWidth <= 1 || this.scrollEl.clientHeight <= 1) &&
				attempts < 10
			) {
				this.runWhenCanvasReady(callback, attempts + 1);
				return;
			}

			callback();
		});
	}

	private getMinZoom() {
		const viewportWidth = Math.max(1, this.scrollEl?.clientWidth ?? 1);
		const viewportHeight = Math.max(1, this.scrollEl?.clientHeight ?? 1);
		const minScrollableZoom = Math.max(
			(viewportWidth + MIN_SCROLLABLE_OVERFLOW) / STAGE_WIDTH,
			(viewportHeight + MIN_SCROLLABLE_OVERFLOW) / STAGE_HEIGHT
		);

		return clamp(minScrollableZoom, MIN_ZOOM, MAX_ZOOM);
	}

	private enforceZoomBounds() {
		const minZoom = this.getMinZoom();
		if (this.zoom >= minZoom) {
			return;
		}

		this.zoom = minZoom;
		this.syncStageZoom();
	}

	private getStagePointFromViewport(viewportX: number, viewportY: number) {
		return {
			x:
				(this.scrollEl.scrollLeft + viewportX - this.viewportOffsetX) /
				this.zoom,
			y:
				(this.scrollEl.scrollTop + viewportY - this.viewportOffsetY) /
				this.zoom
		};
	}

	private anchorViewportOnStagePoint(
		stageX: number,
		stageY: number,
		viewportX: number,
		viewportY: number
	) {
		this.positionViewportAroundStagePoint(
			stageX,
			stageY,
			viewportX,
			viewportY
		);
		this.scheduleGridRender();
	}

	private positionViewportAroundStagePoint(
		stageX: number,
		stageY: number,
		viewportX: number,
		viewportY: number
	) {
		const xAxis = this.solveViewportAxis(
			stageX * this.zoom,
			viewportX,
			STAGE_WIDTH * this.zoom,
			this.scrollEl.clientWidth
		);
		const yAxis = this.solveViewportAxis(
			stageY * this.zoom,
			viewportY,
			STAGE_HEIGHT * this.zoom,
			this.scrollEl.clientHeight
		);

		this.scrollEl.scrollLeft = xAxis.scroll;
		this.scrollEl.scrollTop = yAxis.scroll;
		this.viewportOffsetX = xAxis.offset;
		this.viewportOffsetY = yAxis.offset;
		this.applyViewportOffset();
	}

	private normalizeViewportPresentation() {
		const metrics = this.getViewportMetrics();
		this.scrollEl.scrollLeft = clamp(this.scrollEl.scrollLeft, 0, metrics.maxScrollLeft);
		this.scrollEl.scrollTop = clamp(this.scrollEl.scrollTop, 0, metrics.maxScrollTop);
		this.viewportOffsetX = clamp(this.viewportOffsetX, 0, metrics.slackX);
		this.viewportOffsetY = clamp(this.viewportOffsetY, 0, metrics.slackY);
		this.applyViewportOffset();
	}

	private applyViewportOffset() {
		this.stageViewportEl.style.left = `${this.viewportOffsetX}px`;
		this.stageViewportEl.style.top = `${this.viewportOffsetY}px`;
	}

	private getViewportMetrics() {
		const scaledWidth = STAGE_WIDTH * this.zoom;
		const scaledHeight = STAGE_HEIGHT * this.zoom;
		const viewportWidth = Math.max(1, this.scrollEl.clientWidth);
		const viewportHeight = Math.max(1, this.scrollEl.clientHeight);

		return {
			scaledWidth,
			scaledHeight,
			viewportWidth,
			viewportHeight,
			maxScrollLeft: Math.max(0, scaledWidth - viewportWidth),
			maxScrollTop: Math.max(0, scaledHeight - viewportHeight),
			slackX: Math.max(0, viewportWidth - scaledWidth),
			slackY: Math.max(0, viewportHeight - scaledHeight)
		};
	}

	private solveViewportAxis(
		scaledStagePoint: number,
		viewportPoint: number,
		scaledStageSize: number,
		viewportSize: number
	) {
		const maxScroll = Math.max(0, scaledStageSize - viewportSize);
		const slack = Math.max(0, viewportSize - scaledStageSize);
		const scroll = clamp(scaledStagePoint - viewportPoint, 0, maxScroll);
		const offset = clamp(viewportPoint - scaledStagePoint + scroll, 0, slack);

		return { scroll, offset };
	}

	private scheduleGridRender() {
		if (!this.gridCanvasEl || this.gridRenderFrame !== null) {
			return;
		}

		this.gridRenderFrame = window.requestAnimationFrame(() => {
			this.gridRenderFrame = null;
			this.renderGrid();
		});
	}

	private renderGrid() {
		const canvas = this.gridCanvasEl;
		const width = Math.max(1, Math.floor(this.canvasEl.clientWidth));
		const height = Math.max(1, Math.floor(this.canvasEl.clientHeight));
		const dpr = window.devicePixelRatio || 1;
		const backingWidth = Math.max(1, Math.floor(width * dpr));
		const backingHeight = Math.max(1, Math.floor(height * dpr));

		if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
			canvas.width = backingWidth;
			canvas.height = backingHeight;
		}

		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;

		const context = canvas.getContext("2d");
		if (!context) {
			return;
		}

		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, backingWidth, backingHeight);
		context.scale(dpr, dpr);

		const dotColor = getComputedStyle(this.canvasEl)
			.getPropertyValue("--arkidian-grid-dot-color")
			.trim() || "rgba(128, 128, 128, 0.32)";
		const baseSpacing = GRID_SPACING * this.zoom;
		const spacingMultiplier = Math.max(
			1,
			2 ** Math.ceil(Math.log2(MIN_GRID_SCREEN_SPACING / Math.max(baseSpacing, 1)))
		);
		const spacing = baseSpacing * spacingMultiplier;

		if (!Number.isFinite(spacing) || spacing < 6) {
			return;
		}

		const originX = STAGE_WIDTH / 2;
		const originY = STAGE_HEIGHT / 2;
		const screenOriginX =
			originX * this.zoom - this.scrollEl.scrollLeft + this.viewportOffsetX;
		const screenOriginY =
			originY * this.zoom - this.scrollEl.scrollTop + this.viewportOffsetY;
		const startX =
			mod(screenOriginX, spacing) - (screenOriginX < 0 ? 0 : spacing);
		const startY =
			mod(screenOriginY, spacing) - (screenOriginY < 0 ? 0 : spacing);

		context.fillStyle = dotColor;

		for (let y = startY; y <= height + spacing; y += spacing) {
			for (let x = startX; x <= width + spacing; x += spacing) {
				context.beginPath();
				context.arc(x, y, GRID_DOT_RADIUS, 0, Math.PI * 2);
				context.fill();
			}
		}
	}

	private queueZoomSave() {
		if (this.zoomSaveTimer !== null) {
			window.clearTimeout(this.zoomSaveTimer);
		}

		this.zoomSaveTimer = window.setTimeout(() => {
			void this.persistZoomState();
			this.zoomSaveTimer = null;
		}, 150);
	}

	private async renderSectionCard(section: SectionNode, state: CanvasItemState) {
		const card = this.stageEl.createDiv({ cls: "arkidian-card" });
		this.enableItemSelection(card, section.id);
		applyItemFrame(card, state);

		const body = card.createDiv({ cls: "arkidian-card-body" });
		const preview = body.createDiv({ cls: "arkidian-preview" });
		await this.renderMarkdownPreview(preview, section.content);
		state.height = Math.max(DEFAULT_CARD_HEIGHT, Math.ceil(card.offsetHeight));
		applyItemFrame(card, state);
		card.addEventListener("click", (event) => {
			if (shouldIgnoreCardActivation(event.target)) {
				return;
			}
			if (!(event.metaKey || event.ctrlKey)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			void this.enterScope(section.scopeId);
		});
		card.addEventListener("dblclick", (event) => {
			if (shouldIgnoreCardActivation(event.target)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			void this.openSourceInPopout(section.startLine);
		});

		this.enableDragging(card, card, section.id, state);
		this.enableCardResizing(card, section.id, state);
	}

	private async renderOrphan(orphan: OrphanNode, state: CanvasItemState) {
		const item = this.stageEl.createDiv({ cls: "arkidian-orphan" });
		this.enableItemSelection(item, orphan.id);
		item.toggleClass("is-drillable", Boolean(orphan.childScopeId));
		applyItemFrame(item, state);

		const preview = item.createDiv({ cls: "arkidian-preview" });
		await this.renderMarkdownPreview(preview, orphan.content.trim());
		state.height = Math.max(1, Math.ceil(item.offsetHeight));
		applyItemFrame(item, state);
		item.addEventListener("click", (event) => {
			if (shouldIgnoreCardActivation(event.target)) {
				return;
			}
			if (!(event.metaKey || event.ctrlKey) || !orphan.childScopeId) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			void this.enterScope(orphan.childScopeId);
		});
		item.addEventListener("dblclick", (event) => {
			if (shouldIgnoreCardActivation(event.target)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			void this.openSourceInPopout(orphan.startLine);
		});

		this.enableDragging(item, item, orphan.id, state);
		this.enableCardResizing(item, orphan.id, state);
	}

	private async renderFrontmatterCard(
		frontmatter: FrontmatterItem,
		state: CanvasItemState
	) {
		const card = this.stageEl.createDiv({
			cls: "arkidian-orphan arkidian-frontmatter-card"
		});
		this.enableItemSelection(card, frontmatter.id);
		applyItemFrame(card, state);

		const body = card.createDiv({ cls: "arkidian-frontmatter-card-body" });
		const table = body.createEl("table", {
			cls: "arkidian-frontmatter-table"
		});
		const tbody = table.createEl("tbody");
		const rows: Array<{ keyInput: HTMLInputElement; valueInput: HTMLInputElement }> =
			[];

		const focusOrCreateNextRow = (
			currentKeyInput: HTMLInputElement,
			target: "key" | "value"
		) => {
			const index = rows.findIndex((row) => row.keyInput === currentKeyInput);
			if (index === -1) {
				return;
			}

			const next = rows[index + 1];
			if (next) {
				(target === "key" ? next.keyInput : next.valueInput).focus();
				return;
			}

			const input = appendInputRow();
			if (target === "key") {
				input.focus();
			} else {
				const created = rows[rows.length - 1];
				created?.valueInput.focus();
			}
		};

		const appendInputRow = (existing?: FrontmatterTableRow) => {
			const row = tbody.createEl("tr", {
				cls: "arkidian-frontmatter-input-row"
			});
			let persistedKey = existing?.key;
			const keyCell = row.createEl("td");
			const keyInput = keyCell.createEl("input", {
				type: "text",
				placeholder: "key"
			});
			keyInput.value = existing?.key ?? "";
			const valueCell = row.createEl("td");
			const valueInput = valueCell.createEl("input", {
				type: "text",
				placeholder: "value"
			});
			valueInput.value = existing?.value ?? "";
			const actions = row.createEl("td", {
				cls: "arkidian-frontmatter-actions-cell"
			});
			const deleteButton = createInteractiveControl(actions, {
				cls: "arkidian-frontmatter-delete-button",
				label: "Delete property",
				tabIndex: -1
			});
			setIcon(deleteButton, "x");
			let saveTimer: number | null = null;
			const rowInputs = { keyInput, valueInput };
			rows.push(rowInputs);

			const save = async () => {
				const nextRow = {
					key: keyInput.value.trim(),
					value: valueInput.value.trim()
				};
				if (!nextRow.key && !nextRow.value && !existing?.key) {
					const rowIndex = rows.indexOf(rowInputs);
					if (rowIndex !== -1) {
						rows.splice(rowIndex, 1);
					}
					row.remove();
					this.refreshFrontmatterCardHeight(card, state);
					return;
				}
				if (!nextRow.key) {
					return;
				}

				await this.saveFrontmatterRow(nextRow, persistedKey);
				persistedKey = nextRow.key;
			};

			const queueSave = () => {
				if (saveTimer !== null) {
					window.clearTimeout(saveTimer);
				}
				saveTimer = window.setTimeout(() => {
					void save();
					saveTimer = null;
				}, 350);
			};

			deleteButton.addEventListener("click", () => {
				if (!existing?.key && !keyInput.value.trim() && !valueInput.value.trim()) {
					const rowIndex = rows.indexOf(rowInputs);
					if (rowIndex !== -1) {
						rows.splice(rowIndex, 1);
					}
					row.remove();
					this.refreshFrontmatterCardHeight(card, state);
					return;
				}
				if (existing?.key) {
					const rowIndex = rows.indexOf(rowInputs);
					if (rowIndex !== -1) {
						rows.splice(rowIndex, 1);
					}
					row.remove();
					this.refreshFrontmatterCardHeight(card, state);
					void this.deleteFrontmatterKey(persistedKey);
				}
			});

			keyInput.addEventListener("input", queueSave);
			valueInput.addEventListener("input", queueSave);
			keyInput.addEventListener("blur", () => {
				void save();
			});
			valueInput.addEventListener("blur", () => {
				void save();
			});
			keyInput.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					void save();
					focusOrCreateNextRow(keyInput, "key");
				}
				if (event.key === "Tab" && !event.shiftKey) {
					event.preventDefault();
					if (keyInput === rows[rows.length - 1]?.keyInput) {
						void save();
					}
					valueInput.focus();
				}
			});
			valueInput.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					void save();
					focusOrCreateNextRow(keyInput, "key");
				}
				if (
					event.key === "Tab" &&
					!event.shiftKey &&
					valueInput === rows[rows.length - 1]?.valueInput
				) {
					event.preventDefault();
					void save();
					focusOrCreateNextRow(keyInput, "key");
				}
			});

			this.refreshFrontmatterCardHeight(card, state);
			return keyInput;
		};

		if (!frontmatter.rows.length) {
			appendInputRow();
		} else {
			frontmatter.rows.forEach((rowData) => {
				appendInputRow(rowData);
			});
		}

		this.refreshFrontmatterCardHeight(card, state);
		this.enableDragging(card, card, frontmatter.id, state);
		this.enableCardResizing(card, frontmatter.id, state);
	}

	private refreshFrontmatterCardHeight(card: HTMLElement, state: CanvasItemState) {
		card.style.minHeight = "0px";
		state.height = Math.max(72, Math.ceil(card.scrollHeight));
		applyItemFrame(card, state);
	}

	private enableItemSelection(target: HTMLElement, itemId: string) {
		target.dataset.itemId = itemId;
		target.addEventListener("pointerdown", (event) => {
			if (this.isSpacePressed || event.button !== 0) {
				return;
			}
			this.selectItem(itemId, target);
		});
	}

	private selectItem(itemId: string, element: HTMLElement) {
		if (this.selectedItemId === itemId && this.selectedItemEl === element) {
			element.addClass("is-selected");
			this.rerenderCurrentLayerPanel();
			return;
		}

		this.selectedItemEl?.removeClass("is-selected");
		this.selectedItemId = itemId;
		this.selectedItemEl = element;
		element.addClass("is-selected");
		this.rerenderCurrentLayerPanel();
	}

	private selectItemById(itemId: string) {
		const element = this.stageEl.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`);
		if (!element) {
			this.clearSelectedItem();
			return;
		}
		this.selectItem(itemId, element);
	}

	private clearSelectedItem() {
		if (!this.selectedItemId && !this.selectedItemEl) {
			return;
		}
		this.selectedItemEl?.removeClass("is-selected");
		this.selectedItemId = null;
		this.selectedItemEl = null;
		this.rerenderCurrentLayerPanel();
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
			if (this.isSpacePressed || event.button !== 0) {
				return;
			}
			if (isInteractiveTarget(event.target)) {
				return;
			}
			this.selectItem(itemId, target);
			startX = event.clientX;
			startY = event.clientY;
			originX = state.x;
			originY = state.y;
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", onPointerUp);
		});
		target.addEventListener("dragstart", (event) => {
			event.preventDefault();
		});
	}

	private enableCardResizing(
		card: HTMLElement,
		itemId: string,
		state: CanvasItemState
	) {
		const resizeHandle = card.createDiv({ cls: "arkidian-card-resize-handle" });
		let startX = 0;
		let originWidth = state.width;

		const onPointerMove = (event: PointerEvent) => {
			const deltaX = (event.clientX - startX) / this.zoom;
			state.width = clamp(originWidth + deltaX, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
			applyItemFrame(card, state);
		};

		const onPointerUp = () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			void this.persistItemState(itemId, state);
		};

		resizeHandle.addEventListener("pointerdown", (event) => {
			if (this.isSpacePressed || event.button !== 0) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			this.selectItem(itemId, card);
			startX = event.clientX;
			originWidth = state.width;
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
		container.addClass("markdown-rendered", "markdown-preview-view");
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
		container.querySelectorAll("img").forEach((image) => {
			image.draggable = false;
		});
	}

	private async openSourceInPopout(line: number) {
		if (!this.currentFile) {
			return;
		}

		try {
			const leaf = this.app.workspace.openPopoutLeaf();
			await leaf.openFile(this.currentFile, {
				active: true,
				state: {
					mode: "source"
				}
			});
			await this.app.workspace.revealLeaf(leaf);

			const view = leaf.view instanceof MarkdownView ? leaf.view : null;
			const editor = view?.editor as EditorLike | undefined;
			if (!editor) {
				new Notice("Opened the note, but could not access the editor for zooming.");
				return;
			}

			const linePosition = { line, ch: 0 };
			editor.setCursor(linePosition);
			editor.scrollIntoView({ from: linePosition, to: linePosition }, true);

			const zoomPlugin = window.ObsidianZoomPlugin;
			if (!zoomPlugin) {
				new Notice("Opened the note in a new window. Zoom plugin is not available.");
				return;
			}

			zoomPlugin.zoomIn(editor, line);
		} catch (error) {
			console.error("Arkidian: failed to open source in popout", error);
			new Notice("Could not open this source block in a new editor window.");
		}
	}

	private getMetaPath(file: TFile) {
		const parent = file.parent?.path;
		const base = `${file.basename}${META_SUFFIX}`;
		return parent ? `${parent}/${base}` : base;
	}

	private async enterScope(scopeId: string) {
		this.currentScopeId = scopeId;
		this.fittedScopeId = null;
		await this.renderCurrentFile();
	}

	private getScopeMeta(meta: CanvasMeta, scopeId: string) {
		return (
			meta.scopes[scopeId] ?? {
				zoom: 1,
				items: {}
			}
		);
	}

	private async readMeta(file: TFile): Promise<CanvasMeta> {
		const metaPath = this.getMetaPath(file);
		const existing = this.app.vault.getAbstractFileByPath(metaPath);
		if (!(existing instanceof TFile)) {
			return {
				version: 2,
				scopes: {}
			};
		}

		try {
			const parsed = JSON.parse(await this.app.vault.read(existing)) as
				| CanvasMeta
				| {
						version?: number;
						zoom?: number;
						items?: Record<string, CanvasItemState>;
				  };
			if ("scopes" in parsed && parsed.scopes) {
				return {
					version: 2,
					scopes: parsed.scopes
				};
			}
			return {
				version: 2,
				scopes: {
					"scope:root": {
						zoom: parsed.zoom ?? 1,
						items: parsed.items ?? {}
					}
				}
			};
		} catch {
			new Notice("Could not parse Arkidian metadata. Resetting layout.");
			return {
				version: 2,
				scopes: {}
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
		const scopeMeta = this.getScopeMeta(meta, this.currentScopeId);
		scopeMeta.items[itemId] = state;
		scopeMeta.zoom = this.zoom;
		meta.scopes[this.currentScopeId] = scopeMeta;
		await this.writeMeta(meta);
	}

	private async persistZoomState() {
		if (!this.currentFile) {
			return;
		}

		const meta = await this.readMeta(this.currentFile);
		const scopeMeta = this.getScopeMeta(meta, this.currentScopeId);
		scopeMeta.zoom = this.zoom;
		meta.scopes[this.currentScopeId] = scopeMeta;
		await this.writeMeta(meta);
	}

	private getDefaultItemState(
		id: string,
		index: number,
		isOrphan: boolean,
		isFrontmatter = false
	): CanvasItemState {
		const cardSpacingX = 460;
		const cardSpacingY = 380;
		const orphanSpacingY = 190;
		const column = index % 3;
		const row = Math.floor(index / 3);
		if (isFrontmatter) {
			return {
				id,
				x: -cardSpacingX - 80,
				y: -cardSpacingY,
				width: 520,
				height: DEFAULT_CARD_HEIGHT
			};
		}

		return {
			id,
			x: isOrphan
				? -DEFAULT_CARD_WIDTH - 220
				: (column - 1) * cardSpacingX,
			y: isOrphan
				? -DEFAULT_CARD_HEIGHT / 2 + index * orphanSpacingY
				: (row - 1) * cardSpacingY,
			width: DEFAULT_CARD_WIDTH,
			height: isOrphan ? 140 : DEFAULT_CARD_HEIGHT
		};
	}
}

function parseMarkdownStructure(markdown: string): ParsedDocument {
	const frontmatterInfo = getFrontMatterInfo(markdown);
	const body = frontmatterInfo.exists
		? markdown.slice(frontmatterInfo.contentStart)
		: markdown;
	const lineOffset = getLineCount(markdown.slice(0, frontmatterInfo.contentStart));
	const tree = unified().use(remarkParse).parse(body) as Root;
	const lines = body.split(/\r?\n/);
	const scopes: Record<string, ParsedScope> = {};
	const allHeadings = tree.children.filter(
		(node): node is Heading => node.type === "heading"
	);
	buildScope(
		tree.children,
		"scope:root",
		"Global",
		[],
		scopes,
		body,
		lines,
		lineOffset
	);
	return {
		scopes,
		rootScopeId: "scope:root",
		maxHeadingDepth: allHeadings.reduce(
			(max, heading) => Math.max(max, heading.depth),
			0
		)
	};
}

function buildScope(
	nodes: Content[],
	scopeId: string,
	title: string,
	parentPath: string[],
	scopes: Record<string, ParsedScope>,
	markdown: string,
	lines: string[],
	lineOffset: number,
	scopeHeading: Heading | null = null
) {
	const headings = nodes
		.map((node, index) => (node.type === "heading" ? { node, index } : null))
		.filter(Boolean) as Array<{ node: Heading; index: number }>;
	const minDepth =
		headings.length > 0
			? Math.min(...headings.map(({ node }) => node.depth))
			: null;
	const scopeSections: SectionNode[] = [];
	const scopeOrphans: OrphanNode[] = [];

	if (scopeHeading) {
		scopeOrphans.push(
			createScopeHeadingOrphan(scopeHeading, scopeId, markdown, lines)
		);
	}

	if (minDepth === null) {
		scopeOrphans.push(
			...buildShellLessNodes(
				nodes,
				scopeId,
				markdown,
				lines,
				parentPath,
				scopes,
				lineOffset
			)
		);
	} else {
		const shellHeadings = headings.filter(({ node }) => node.depth === minDepth);
		const firstShellIndex = shellHeadings[0]?.index ?? 0;
		scopeOrphans.push(
			...buildShellLessNodes(
				nodes.slice(0, firstShellIndex),
				scopeId,
				markdown,
				lines,
				parentPath,
				scopes,
				lineOffset
			)
		);

		shellHeadings.forEach(({ node, index }, shellIndex) => {
			const nextShellIndex = shellHeadings[shellIndex + 1]?.index ?? nodes.length;
			const shellPath = [...parentPath, toString(node).trim()];
			const sectionId = `section:${shellPath.join(" > ")}`;
			const childScopeId = `scope:${shellPath.join(" > ")}`;
			const bodyNodes = nodes.slice(index + 1, nextShellIndex);

			scopeSections.push({
				id: sectionId,
				title: toString(node).trim(),
				level: node.depth,
				path: shellPath,
				startLine: getNodeStartLine(node, lineOffset),
				endLine: getScopeEndLine(bodyNodes, node, lines, lineOffset),
				content: [getNodeMarkdown(markdown, lines, node), ...bodyNodes.map((bodyNode) => getNodeMarkdown(markdown, lines, bodyNode))]
					.filter((part) => part.trim().length > 0)
					.join("\n\n"),
				scopeId: childScopeId
			});

			buildScope(
				bodyNodes,
				childScopeId,
				toString(node).trim(),
				shellPath,
				scopes,
				markdown,
				lines,
				lineOffset,
				node
			);
		});
	}

	scopes[scopeId] = {
		id: scopeId,
		title,
		startLine: nodes.length ? getNodeStartLine(nodes[0], lineOffset) : 0,
		endLine: nodes.length ? getNodeEndLine(nodes[nodes.length - 1], lineOffset) : 0,
		depth: minDepth,
		sections: scopeSections,
		orphans: scopeOrphans
	};
}

function createScopeHeadingOrphan(
	heading: Heading,
	scopeId: string,
	markdown: string,
	lines: string[],
	lineOffset: number
): OrphanNode {
	return {
		id: `orphan:${scopeId}:scope-heading`,
		content: getNodeMarkdown(markdown, lines, heading),
		startLine: getNodeStartLine(heading, lineOffset),
		endLine: getNodeEndLine(heading, lineOffset),
		scopeId
	};
}

function createFileTitleOrphan(fileName: string): OrphanNode {
	return {
		id: "orphan:scope:root:file-title",
		content: `# ${escapeMarkdownHeadingText(fileName)}`,
		startLine: 0,
		endLine: 0,
		scopeId: "scope:root"
	};
}

function buildShellLessNodes(
	nodes: Content[],
	scopeId: string,
	markdown: string,
	lines: string[],
	parentPath: string[],
	scopes: Record<string, ParsedScope>,
	lineOffset: number
) {
	if (!nodes.length) {
		return [];
	}

	const headings = nodes
		.map((node, index) => (node.type === "heading" ? { node, index } : null))
		.filter(Boolean) as Array<{ node: Heading; index: number }>;
	if (!headings.length) {
		return [
			{
				id: `orphan:${scopeId}:0`,
				content: nodes.map((node) => getNodeMarkdown(markdown, lines, node)).join("\n\n"),
				startLine: getNodeStartLine(nodes[0], lineOffset),
				endLine: getNodeEndLine(nodes[nodes.length - 1], lineOffset),
				scopeId
			}
		];
	}

	const minDepth = Math.min(...headings.map(({ node }) => node.depth));
	const groups = headings.filter(({ node }) => node.depth === minDepth);
	const orphans: OrphanNode[] = [];
	const prefix = nodes.slice(0, groups[0]?.index ?? 0);
	if (prefix.length) {
		orphans.push({
			id: `orphan:${scopeId}:prefix`,
			content: prefix.map((node) => getNodeMarkdown(markdown, lines, node)).join("\n\n"),
			startLine: getNodeStartLine(prefix[0], lineOffset),
			endLine: getNodeEndLine(prefix[prefix.length - 1], lineOffset),
			scopeId
		});
	}

	groups.forEach(({ node, index }, groupIndex) => {
		const nextIndex = groups[groupIndex + 1]?.index ?? nodes.length;
		const groupNodes = nodes.slice(index, nextIndex);
		const bodyNodes = groupNodes.slice(1);
		const headingTitle = toString(node).trim();
		const label = [...parentPath, headingTitle].join(" > ") || `${groupIndex}`;
		const childScopeId = `scope:${scopeId}:orphan:${label}`;

		buildScope(
			bodyNodes,
			childScopeId,
			headingTitle,
			[...parentPath, headingTitle],
			scopes,
			markdown,
			lines,
			lineOffset,
			node
		);

		orphans.push({
			id: `orphan:${scopeId}:${label}`,
			content: groupNodes
				.map((groupNode) => getNodeMarkdown(markdown, lines, groupNode))
				.join("\n\n"),
			startLine: getNodeStartLine(groupNodes[0], lineOffset),
			endLine: getNodeEndLine(groupNodes[groupNodes.length - 1], lineOffset),
			scopeId,
			childScopeId
		});
	});

	return orphans.filter((orphan) => orphan.content.trim().length > 0);
}

function getScopeEndLine(
	nodes: Content[],
	heading: Heading,
	lines: string[],
	lineOffset: number
) {
	if (!nodes.length) {
		return Math.max(
			getNodeStartLine(heading, lineOffset),
			getNodeEndLine(heading, lineOffset)
		);
	}
	return Math.max(
		getNodeEndLine(nodes[nodes.length - 1], lineOffset),
		getNodeEndLine(heading, lineOffset),
		lineOffset + lines.length - 1
	);
}

function getNodeMarkdown(markdown: string, lines: string[], node: Content | Heading) {
	const startOffset = node.position?.start.offset;
	const endOffset = node.position?.end.offset;
	if (typeof startOffset === "number" && typeof endOffset === "number") {
		return markdown.slice(startOffset, endOffset);
	}
	return lines
		.slice(getNodeStartLine(node), getNodeEndLine(node) + 1)
		.join("\n");
}

function getNodeStartLine(node: Content | Heading, lineOffset = 0) {
	return Math.max(0, lineOffset + (node.position?.start.line ?? 1) - 1);
}

function getNodeEndLine(node: Content | Heading, lineOffset = 0) {
	return Math.max(
		getNodeStartLine(node, lineOffset),
		lineOffset + (node.position?.end.line ?? 1) - 1
	);
}

function getParentScopeId(scopeId: string) {
	if (scopeId === "scope:root") {
		return null;
	}
	const rawPath = scopeId.slice("scope:".length);
	const parts = rawPath.split(" > ");
	if (parts.length <= 1) {
		return "scope:root";
	}
	return `scope:${parts.slice(0, -1).join(" > ")}`;
}

function getScopePathSegments(scopeId: string) {
	if (scopeId === "scope:root") {
		return [];
	}

	return scopeId
		.slice("scope:".length)
		.split(" > ")
		.filter((segment) => segment.length > 0);
}

function escapeMarkdownHeadingText(text: string) {
	return text.replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
}

function getLineCount(text: string) {
	if (!text.length) {
		return 0;
	}

	return text.split(/\r?\n/).length - 1;
}

function createInteractiveControl(
	parent: HTMLElement,
	options: {
		cls: string;
		text?: string;
		label?: string;
		tabIndex?: number;
	}
) {
	const control = parent.createDiv({
		cls: options.cls,
		text: options.text
	});
	control.setAttribute("role", "button");
	control.tabIndex = options.tabIndex ?? 0;
	if (options.label) {
		control.setAttribute("aria-label", options.label);
	}
	control.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}
		if (control.getAttribute("aria-disabled") === "true") {
			return;
		}
		event.preventDefault();
		control.click();
	});
	return control;
}

function setInteractiveDisabled(control: HTMLElement, disabled: boolean) {
	control.toggleClass("is-disabled", disabled);
	control.setAttribute("aria-disabled", disabled ? "true" : "false");
	control.tabIndex = disabled ? -1 : 0;
}

function stringifyFrontmatterValue(value: unknown) {
	if (typeof value === "string") {
		return value;
	}

	return JSON.stringify(value);
}

function parseFrontmatterValue(value: string) {
	if (!value.length) {
		return "";
	}

	if (value === "true") {
		return true;
	}
	if (value === "false") {
		return false;
	}
	if (value === "null") {
		return null;
	}
	if (/^-?\d+(\.\d+)?$/.test(value)) {
		return Number(value);
	}
	if (
		(value.startsWith("[") && value.endsWith("]")) ||
		(value.startsWith("{") && value.endsWith("}"))
	) {
		return JSON.parse(value);
	}

	return value;
}

function getRenderableKindPriority(
	kind: RenderableScopeItem["kind"]
) {
	switch (kind) {
		case "frontmatter":
			return 0;
		case "section":
			return 1;
		case "orphan":
			return 2;
	}
}

function getOrphanLayerLabel(orphan: OrphanNode) {
	const firstMeaningfulLine = orphan.content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);

	if (!firstMeaningfulLine) {
		return "Untitled block";
	}

	const headingMatch = firstMeaningfulLine.match(/^#{1,6}\s+(.*)$/);
	const label = headingMatch?.[1] ?? firstMeaningfulLine;
	return label.length > 34 ? `${label.slice(0, 31).trimEnd()}...` : label;
}

function getHeadingIcon(level: number) {
	switch (Math.max(1, Math.min(6, level))) {
		case 1:
			return "heading-1";
		case 2:
			return "heading-2";
		case 3:
			return "heading-3";
		case 4:
			return "heading-4";
		case 5:
			return "heading-5";
		case 6:
		default:
			return "heading-6";
	}
}

function getOrphanLayerIcon(orphan: OrphanNode) {
	const firstMeaningfulLine = orphan.content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);

	if (!firstMeaningfulLine) {
		return "minus";
	}

	const headingMarker = firstMeaningfulLine.match(/^#{1,6}/)?.[0];
	if (headingMarker) {
		return getHeadingIcon(headingMarker.length);
	}
	if (firstMeaningfulLine.startsWith(">")) {
		return "text-quote";
	}
	if (
		firstMeaningfulLine.startsWith("- ") ||
		firstMeaningfulLine.startsWith("* ") ||
		firstMeaningfulLine.startsWith("+ ")
	) {
		return "list";
	}
	if (/^\d+[.)]\s/.test(firstMeaningfulLine)) {
		return "list-ordered";
	}
	return "minus";
}

function applyItemFrame(element: HTMLElement, state: CanvasItemState) {
	element.style.left = `${STAGE_WIDTH / 2 + state.x}px`;
	element.style.top = `${STAGE_HEIGHT / 2 + state.y}px`;
	element.style.width = `${state.width}px`;
	if (element.classList.contains("arkidian-orphan")) {
		element.style.height = "auto";
		element.style.minHeight = "0";
		return;
	}
	element.style.minHeight = `${state.height}px`;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function mod(value: number, divisor: number) {
	return ((value % divisor) + divisor) % divisor;
}

function getItemBounds(itemStates: CanvasItemState[]) {
	let minX = 0;
	let minY = 0;
	let maxX = 0;
	let maxY = 0;

	for (const item of itemStates) {
		minX = Math.min(minX, item.x);
		minY = Math.min(minY, item.y);
		maxX = Math.max(maxX, item.x + item.width);
		maxY = Math.max(maxY, item.y + item.height);
	}

	return {
		minX,
		minY,
		maxX,
		maxY,
		centerX: (minX + maxX) / 2,
		centerY: (minY + maxY) / 2
	};
}

function isTypingTarget(target: EventTarget | null) {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT")
	);
}

function shouldIgnoreCardActivation(target: EventTarget | null) {
	return (
		target instanceof HTMLElement &&
		(Boolean(target.closest("a")) || isTypingTarget(target))
	);
}

function isInteractiveTarget(target: EventTarget | null) {
	return (
		target instanceof HTMLElement &&
		(Boolean(target.closest('[role="button"]')) ||
			Boolean(target.closest("input")) ||
			Boolean(target.closest("textarea")) ||
			Boolean(target.closest("select")) ||
			Boolean(target.closest("label")))
	);
}
