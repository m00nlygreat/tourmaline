import {
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	setIcon,
	TFile,
	ViewStateResult,
	WorkspaceLeaf
} from "obsidian";
import { CardRenderer } from "./card-renderer";
import {
	applyItemFrame,
	clamp,
	compareDocumentPosition,
	createFileTitleOrphan,
	createInteractiveControl,
	cssEscape,
	dedupeEmbedsBySource,
	escapeMarkdownHeadingText,
	findLayerNodePathIds,
	getDisplayLabelText,
	getEmbedLayerLabel,
	getExpandableLayerNodeIds,
	getFileNameFromPath,
	getHeadingIcon,
	getItemBounds,
	getLineCount,
	getOrphanLayerIcon,
	getOrphanLayerLabel,
	getParentScopeId,
	getRenderableKindPriority,
	getRenderableLineRange,
	getRenderableLineSpan,
	getRenderedEmbedElements,
	getScopeInsertLine,
	getScopePathSegments,
	isEmbedInsideRenderable,
	isInteractiveTarget,
	isTypingTarget,
	mergeLayerChildren,
	normalizeEmbedBreadcrumbLabel,
	parseFrontmatterValue,
	parseMarkdownStructure,
	removeScopeMetaTree,
	setInteractiveDisabled,
	shouldFlattenOrphanLayerEmbeds,
	stringifyFrontmatterValue
} from "./domain";
import type { MetadataCache } from "obsidian";
import {
	DEFAULT_CARD_HEIGHT,
	DEFAULT_CARD_WIDTH,
	DEFAULT_LAYER_PANEL_WIDTH,
	MAX_CARD_WIDTH,
	MAX_LAYER_PANEL_WIDTH,
	MAX_ZOOM,
	MIN_CARD_WIDTH,
	MIN_LAYER_PANEL_WIDTH,
	STAGE_HEIGHT,
	STAGE_WIDTH,
	TOURMALINE_ICON,
	VIEW_TYPE_ARKIDIAN
} from "./constants";
import { EmbedResolver } from "./embed-resolver";
import { GridRenderer } from "./grid-renderer";
import { LayerPanel } from "./layer-panel";
import { CanvasMetaStore } from "./meta-store";
import { SelectionController } from "./selection-controller";
import {
	SourceEditService
} from "./source-transforms";
import { ViewportController } from "./viewport-controller";
import type {
	ArkidianViewState,
	CanvasItemState,
	CanvasMeta,
	EditorLike,
	EmbedNode,
	FrontmatterItem,
	FrontmatterTableRow,
	LayerTreeNode,
	OrphanNode,
	ParsedDocument,
	ParsedScope,
	RenderableItemContext,
	RenderableScopeItem,
	SectionNode,
	SourceTrailEntry,
	ZoomPluginApi
} from "./types";

declare global {
	interface Window {
		ObsidianZoomPlugin?: ZoomPluginApi;
	}
}
export class ArkidianView extends ItemView {
	private currentFile: TFile | null = null;
	private currentScopeId = "scope:root";
	private parsedDocument: ParsedDocument | null = null;
	private toolbarBreadcrumbsEl!: HTMLDivElement;
	private toolbarActionsEl!: HTMLDivElement;
	private workspaceEl!: HTMLDivElement;
	private layerPanelEl!: HTMLDivElement;
	private layerPanelHeaderEl!: HTMLDivElement;
	private layerPanelExpandAllEl!: HTMLDivElement;
	private layerPanelToggleEl!: HTMLDivElement;
	private layerTreeEl!: HTMLDivElement;
	private layerPanelView!: LayerPanel;
	private cardRenderer!: CardRenderer;
	private canvasEl!: HTMLDivElement;
	private scrollEl!: HTMLDivElement;
	private gridCanvasEl!: HTMLCanvasElement;
	private stageViewportEl!: HTMLDivElement;
	private stageEl!: HTMLDivElement;
	private zoom = 1;
	private viewportOffsetX = 0;
	private viewportOffsetY = 0;
	private saveTimers = new Map<string, number>();
	private suppressFileRefreshUntil = 0;
	private isSpacePressed = false;
	private fittedFilePath: string | null = null;
	private fittedScopeId: string | null = null;
	private gridRenderFrame: number | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private fileRefreshTimer: number | null = null;
	private renderToken = 0;
	private expandedLayerIds = new Set<string>();
	private isLayerPanelCollapsed = false;
	private layerPanelWidth = DEFAULT_LAYER_PANEL_WIDTH;
	private embedMap = new Map<string, EmbedNode[]>();
	private sourceTrail: SourceTrailEntry[] = [];
	private draggingLayerNodeId: string | null = null;
	private readonly metaStore: CanvasMetaStore;
	private readonly embedResolver: EmbedResolver;
	private readonly sourceEditService: SourceEditService;
	private readonly selection = new SelectionController();
	private readonly viewportController = new ViewportController();
	private readonly gridRenderer = new GridRenderer();

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.metaStore = new CanvasMetaStore(this.app.vault);
		this.embedResolver = new EmbedResolver(this.app);
		this.sourceEditService = new SourceEditService(this.app.vault);
	}

	getViewType() {
		return VIEW_TYPE_ARKIDIAN;
	}

	getDisplayText() {
		return "Tourmaline";
	}

	getIcon() {
		return TOURMALINE_ICON;
	}

	getCurrentFile() {
		return this.currentFile;
	}

	async onOpen() {
		this.containerEl.empty();
		this.containerEl.addClass("arkidian-view");

		const toolbar = this.containerEl.createDiv({ cls: "arkidian-toolbar" });
		this.toolbarBreadcrumbsEl = toolbar.createDiv({
			cls: "arkidian-toolbar-breadcrumbs"
		});
		this.toolbarActionsEl = toolbar.createDiv({ cls: "arkidian-toolbar-actions" });
		const refreshButton = createInteractiveControl(this.toolbarActionsEl, {
			cls: "arkidian-toolbar-control",
			text: "Refresh"
		});
		refreshButton.addEventListener("click", () => {
			this.fittedFilePath = null;
			this.fittedScopeId = null;
			void this.renderCurrentFile();
		});

		this.workspaceEl = this.containerEl.createDiv({ cls: "arkidian-workspace" });
		this.layerPanelEl = this.workspaceEl.createDiv({ cls: "arkidian-layer-panel" });
		this.layerPanelHeaderEl = this.layerPanelEl.createDiv({
			cls: "arkidian-layer-panel-header"
		});
		this.layerPanelHeaderEl.createSpan({
			cls: "arkidian-layer-panel-eyebrow",
			text: "Layers"
		});
		const layerPanelActions = this.layerPanelHeaderEl.createDiv({
			cls: "arkidian-layer-panel-actions"
		});
		this.layerPanelExpandAllEl = createInteractiveControl(layerPanelActions, {
			cls: "arkidian-layer-panel-toggle",
			label: "Expand all headings"
		});
		setIcon(this.layerPanelExpandAllEl, "chevrons-down");
		this.layerPanelExpandAllEl.addEventListener("click", () => {
			if (this.layerPanelExpandAllEl.getAttribute("aria-disabled") === "true") {
				return;
			}
			this.toggleAllLayerHeadings();
		});
		this.layerPanelToggleEl = createInteractiveControl(layerPanelActions, {
			cls: "arkidian-layer-panel-toggle",
			label: "Collapse layer panel"
		});
		setIcon(this.layerPanelToggleEl, "panel-left-close");
		this.layerPanelToggleEl.addEventListener("click", () => {
			this.isLayerPanelCollapsed = !this.isLayerPanelCollapsed;
			this.syncLayerPanelPresentation();
		});
		const layerPanelResizeHandle = this.layerPanelEl.createDiv({
			cls: "arkidian-layer-panel-resize-handle"
		});
		this.enableLayerPanelResizing(layerPanelResizeHandle);
		this.layerTreeEl = this.layerPanelEl.createDiv({ cls: "arkidian-layer-tree" });
		this.layerPanelView = new LayerPanel(this.layerTreeEl, {
			getCurrentScopeId: () => this.currentScopeId,
			getSelectedItemId: () => this.selection.selectedItemId,
			isExpanded: (nodeId) => this.expandedLayerIds.has(nodeId),
			toggleExpanded: (nodeId) => {
				if (this.expandedLayerIds.has(nodeId)) {
					this.expandedLayerIds.delete(nodeId);
				} else {
					this.expandedLayerIds.add(nodeId);
				}
				this.rerenderCurrentLayerPanel();
			},
			enableReordering: (row, node) => this.enableLayerRowReordering(row, node),
			selectNode: (node) => this.selectItemById(node.id, { revealOnCanvas: true }),
			enterNode: (node) => {
				void this.enterLayerNode(node);
			},
			openNode: (node) => {
				void this.openLayerNode(node);
			},
			onRendered: (tree) => this.syncLayerHeadingTogglePresentation(tree)
		});
		this.cardRenderer = new CardRenderer({
			renderMarkdownPreview: (container, markdown, embeds) =>
				this.renderMarkdownPreview(container, markdown, embeds),
			enableItemSelection: (target, itemId) => this.enableItemSelection(target, itemId),
			persistItemState: (itemId, state) => {
				void this.persistItemState(itemId, state);
			},
			enterScope: (scopeId) => {
				void this.enterScope(scopeId);
			},
			openSource: (line) => {
				void this.openSourceInPopout(line);
			},
			getZoom: () => this.zoom,
			isSpacePressed: () => this.isSpacePressed,
			selectItem: (itemId, element) => this.selectItem(itemId, element)
		});
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
				return;
			}

			if (
				(event.key === "Delete" || event.key === "Backspace") &&
				!isTypingTarget(event.target)
			) {
				event.preventDefault();
				void this.deleteSelectedItem();
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
		this.syncLayerPanelPresentation();

		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (this.currentFile && file.path === this.currentFile.path) {
					if (Date.now() < this.suppressFileRefreshUntil) {
						return;
					}
					this.queueFileRefresh();
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
		if (this.fileRefreshTimer !== null) {
			window.clearTimeout(this.fileRefreshTimer);
			this.fileRefreshTimer = null;
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

	private queueFileRefresh() {
		if (this.fileRefreshTimer !== null) {
			window.clearTimeout(this.fileRefreshTimer);
		}

		this.fileRefreshTimer = window.setTimeout(() => {
			this.fileRefreshTimer = null;
			void this.renderCurrentFile();
		}, 120);
	}

	private isRenderCurrent(token: number) {
		return token === this.renderToken;
	}

	private swapStageContents(nextStage: HTMLElement) {
		this.stageEl.replaceChildren();
		while (nextStage.firstChild) {
			this.stageEl.appendChild(nextStage.firstChild);
		}
	}

	private async renderCurrentFile() {
		const renderToken = ++this.renderToken;
		this.clearSelectedItem();
		this.renderToolbar();

		const nextStage = document.createElement("div");

		if (!this.currentFile) {
			this.renderEmptyState(nextStage, "Open a markdown file to populate the canvas.");
			if (!this.isRenderCurrent(renderToken)) {
				return;
			}
			this.swapStageContents(nextStage);
			return;
		}

		const source = await this.app.vault.read(this.currentFile);
		if (!this.isRenderCurrent(renderToken)) {
			return;
		}
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
		this.embedMap = await this.buildEmbedMapForDocument();
		if (!this.isRenderCurrent(renderToken)) {
			return;
		}
		const renderableContexts = this.buildRenderableContexts(renderableItems);
		const layerPanelContexts = this.buildLayerPanelRenderableContexts(layerPanelItems);
		const meta = await this.readMeta(this.currentFile);
		if (!this.isRenderCurrent(renderToken)) {
			return;
		}
		const scopeMeta = this.getScopeMeta(meta, this.currentScopeId);
		const itemStates: CanvasItemState[] = [];
		this.renderToolbar(scope);
		this.renderLayerPanel(scope, layerPanelContexts);

		if (!renderableContexts.length) {
			this.renderEmptyState(
				nextStage,
				"This document has no visible markdown blocks yet."
			);
			if (!this.isRenderCurrent(renderToken)) {
				return;
			}
			this.swapStageContents(nextStage);
			this.fitViewportToOriginIfNeeded();
			return;
		}

		const defaultItemStates = this.getDefaultItemStates(renderableContexts);

		for (const context of renderableContexts) {
			const { renderable } = context;
			const state = scopeMeta.items[renderable.id] ?? defaultItemStates[renderable.id];
			itemStates.push(state);
			if (renderable.kind === "frontmatter") {
				await this.renderFrontmatterCard(nextStage, renderable.item, state);
				if (!this.isRenderCurrent(renderToken)) {
					return;
				}
				continue;
			}
			if (renderable.kind === "section") {
				await this.cardRenderer.renderSectionCard(
					nextStage,
					renderable.item,
					state,
					context.embeds
				);
				if (!this.isRenderCurrent(renderToken)) {
					return;
				}
				continue;
			}
			await this.cardRenderer.renderOrphan(nextStage, renderable.item, state, context.embeds);
			if (!this.isRenderCurrent(renderToken)) {
				return;
			}
		}

		if (!this.isRenderCurrent(renderToken)) {
			return;
		}

		this.swapStageContents(nextStage);
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

	private async buildEmbedMapForDocument() {
		const embedMap = new Map<string, EmbedNode[]>();
		if (!this.currentFile || !this.parsedDocument) {
			return embedMap;
		}

		for (const scope of Object.values(this.parsedDocument.scopes)) {
			const renderables = this.getRenderableItems(
				scope,
				this.getFrontmatterItem(scope),
				this.getDisplayOrphans(scope)
			);
			for (const renderable of renderables) {
				if (renderable.kind === "frontmatter") {
					continue;
				}
				embedMap.set(
					renderable.id,
					await this.resolveEmbedsForRenderable(renderable)
				);
			}
		}

		return embedMap;
	}

	private getEmbedsForItem(itemId: string) {
		return this.embedMap.get(itemId) ?? [];
	}

	private buildRenderableContexts(
		renderableItems: RenderableScopeItem[]
	): RenderableItemContext[] {
		return renderableItems.map((renderable) => ({
			renderable,
			embeds: renderable.kind === "frontmatter" ? [] : this.getEmbedsForItem(renderable.id)
		}));
	}

	private buildLayerPanelRenderableContexts(
		renderableItems: RenderableScopeItem[]
	): RenderableItemContext[] {
		const embedOwners = this.getLayerPanelEmbedOwners(renderableItems);
		return renderableItems.map((renderable) => ({
			renderable,
			embeds: renderable.kind === "frontmatter" ? [] : embedOwners.get(renderable.id) ?? []
		}));
	}

	private getLayerPanelEmbedOwners(renderableItems: RenderableScopeItem[]) {
		const ownerMap = new Map<string, EmbedNode[]>();
		const candidates = this.getLayerPanelEmbedOwnerCandidates();
		const embeds = dedupeEmbedsBySource(
			renderableItems.flatMap((renderable) =>
				renderable.kind === "frontmatter" ? [] : this.getEmbedsForItem(renderable.id)
			)
		);

		for (const embed of embeds) {
			const owner = candidates
				.filter((renderable) => isEmbedInsideRenderable(embed, renderable))
				.sort(
					(a, b) =>
						getRenderableLineSpan(a) - getRenderableLineSpan(b) ||
						b.startLine - a.startLine
				)[0];
			if (!owner) {
				continue;
			}

			const ownedEmbeds = ownerMap.get(owner.id) ?? [];
			ownedEmbeds.push(embed);
			ownerMap.set(owner.id, ownedEmbeds);
		}

		for (const ownedEmbeds of ownerMap.values()) {
			ownedEmbeds.sort(
				(a, b) => a.startLine - b.startLine || a.endLine - b.endLine
			);
		}

		return ownerMap;
	}

	private getLayerPanelEmbedOwnerCandidates() {
		if (!this.parsedDocument) {
			return [];
		}

		return Object.values(this.parsedDocument.scopes)
			.flatMap((scope) =>
				this.getRenderableItems(
					scope,
					this.getFrontmatterItem(scope),
					this.getLayerPanelOrphans(scope)
				)
			)
			.filter(
				(
					renderable
				): renderable is Exclude<RenderableScopeItem, { kind: "frontmatter" }> =>
					renderable.kind !== "frontmatter" &&
					!this.isGeneratedLayerPanelOrphan(renderable)
			);
	}

	private isGeneratedLayerPanelOrphan(
		renderable: Exclude<RenderableScopeItem, { kind: "frontmatter" }>
	) {
		return (
			renderable.kind === "orphan" &&
			(renderable.item.id === "orphan:scope:root:file-title" ||
				renderable.item.id.endsWith(":scope-heading"))
		);
	}

	private renderLayerPanel(
		scope: ParsedScope,
		renderableItems: RenderableItemContext[]
	) {
		const tree = this.buildLayerTree(scope.id, renderableItems);
		this.layerPanelView.render(
			scope,
			scope.id === "scope:root" ? this.currentFile?.basename ?? "Document" : scope.title,
			tree
		);
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
			this.buildLayerPanelRenderableContexts(
				this.getRenderableItems(
					scope,
					this.getFrontmatterItem(scope),
					this.getLayerPanelOrphans(scope)
				)
			)
		);
	}

	private buildLayerTree(
		scopeId: string,
		renderableItems: RenderableItemContext[]
	): LayerTreeNode[] {
		return renderableItems.flatMap(({ renderable, embeds }) => {
			if (renderable.kind === "frontmatter") {
				return [{
					id: renderable.id,
					label: "Properties",
					icon: "sliders-horizontal",
					kind: renderable.kind,
					startLine: renderable.startLine,
					sourceScopeId: scopeId,
					openLine: 0,
					children: []
				}];
			}

			if (renderable.kind === "section") {
				const embedChildren = embeds.map((embed) => this.createEmbedLayerNode(embed));
				const descendantChildren = this.buildDescendantLayerTree(
					renderable.item.scopeId
				);
				return [{
					id: renderable.id,
					label: renderable.item.title,
					icon: getHeadingIcon(renderable.item.level),
					kind: renderable.kind,
					startLine: renderable.startLine,
					endLine: renderable.item.endLine,
					sourceScopeId: scopeId,
					targetScopeId: renderable.item.scopeId,
					openLine: renderable.item.startLine,
					children: mergeLayerChildren(descendantChildren, embedChildren)
				}];
			}

			const embedChildren = embeds.map((embed) => this.createEmbedLayerNode(embed));
			const descendantChildren = renderable.item.childScopeId
				? this.buildDescendantLayerTree(renderable.item.childScopeId)
				: [];
			if (embedChildren.length && !descendantChildren.length) {
				if (shouldFlattenOrphanLayerEmbeds(renderable.item, embeds)) {
					return embedChildren;
				}

				return [
					{
						id: renderable.id,
						label: getOrphanLayerLabel(renderable.item),
						icon: getOrphanLayerIcon(renderable.item),
						kind: renderable.kind,
						startLine: renderable.startLine,
						endLine: renderable.item.endLine,
						sourceScopeId: scopeId,
						targetScopeId: renderable.item.childScopeId,
						openLine: renderable.item.startLine,
						children: []
					},
					...embedChildren
				].sort((a, b) => a.startLine - b.startLine);
			}
			return [{
				id: renderable.id,
				label: getOrphanLayerLabel(renderable.item),
				icon: getOrphanLayerIcon(renderable.item),
				kind: renderable.kind,
				startLine: renderable.startLine,
				endLine: renderable.item.endLine,
				sourceScopeId: scopeId,
				targetScopeId: renderable.item.childScopeId,
				openLine: renderable.item.startLine,
				children: mergeLayerChildren(descendantChildren, embedChildren)
			}];
		});
	}

	private buildDescendantLayerTree(scopeId: string): LayerTreeNode[] {
		if (!this.parsedDocument) {
			return [];
		}

		const scope = this.parsedDocument.scopes[scopeId];
		if (!scope) {
			return [];
		}

		return this.buildLayerTree(
			scope.id,
			this.buildLayerPanelRenderableContexts(
				this.getRenderableItems(scope, null, this.getLayerPanelOrphans(scope))
			)
		);
	}

	private createEmbedLayerNode(embed: EmbedNode): LayerTreeNode {
		return {
			id: embed.id,
			label: getEmbedLayerLabel(embed),
			icon: "picture-in-picture-2",
			kind: "embed",
			startLine: embed.startLine,
			endLine: embed.endLine,
			sourceScopeId: embed.sourceScopeId,
			targetScopeId: embed.targetScopeId ?? undefined,
			targetFilePath: embed.targetFilePath ?? undefined,
			openLine: embed.targetLine ?? undefined,
			children: []
		};
	}

	private async resolveEmbedsForRenderable(
		renderable: Exclude<RenderableScopeItem, { kind: "frontmatter" }>
	): Promise<EmbedNode[]> {
		return this.embedResolver.resolveForRenderable(this.currentFile, renderable);
	}

	private async resolveEmbedTarget(link: string) {
		return this.embedResolver.resolveTarget(this.currentFile, link);
	}

	private async enterLayerNode(node: LayerTreeNode) {
		if (node.kind === "embed") {
			const embed = this.findEmbedById(node.id);
			if (embed) {
				await this.enterEmbed(embed);
			}
			return;
		}

		if (
			node.targetScopeId &&
			this.parsedDocument?.scopes[node.targetScopeId]
		) {
			await this.enterScope(node.targetScopeId);
		}
	}

	private async openLayerNode(node: LayerTreeNode) {
		if (node.kind === "embed") {
			const embed = this.findEmbedById(node.id);
			if (embed) {
				await this.openEmbedSource(embed);
			}
			return;
		}

		if (typeof node.openLine === "number") {
			await this.openSourceInPopout(node.openLine);
		}
	}

	private findEmbedById(embedId: string) {
		for (const embeds of this.embedMap.values()) {
			const match = embeds.find((embed) => embed.id === embedId);
			if (match) {
				return match;
			}
		}
		return null;
	}

	private async openTrailLocation(
		filePath: string,
		scopeId: string,
		trailLength: number
	) {
		this.sourceTrail = this.sourceTrail.slice(0, trailLength);
		await this.openCanvasLocation(filePath, scopeId);
	}

	private buildBreadcrumbs(scope?: ParsedScope) {
		const breadcrumbs: Array<{
			label: string;
			isCurrent: boolean;
			onClick?: () => Promise<void>;
		}> = [];

		let lastFilePath: string | null = null;
		for (const [entryIndex, entry] of this.sourceTrail.entries()) {
			if (entry.sourceFilePath !== lastFilePath) {
				breadcrumbs.push({
					label: getFileNameFromPath(entry.sourceFilePath),
					isCurrent: false,
					onClick: async () => {
						await this.openTrailLocation(entry.sourceFilePath, "scope:root", entryIndex);
					}
				});
			}
			lastFilePath = entry.sourceFilePath;
			const sourceSegments = getScopePathSegments(entry.sourceScopeId);
			for (const [segmentIndex, segment] of sourceSegments.entries()) {
				const targetScopeId = `scope:${sourceSegments
					.slice(0, segmentIndex + 1)
					.join(" > ")}`;
				breadcrumbs.push({
					label: segment,
					isCurrent: false,
					onClick: async () => {
						await this.openTrailLocation(
							entry.sourceFilePath,
							targetScopeId,
							entryIndex
						);
					}
				});
			}
			lastFilePath = entry.targetFilePath;
		}

		const rootLabel = this.currentFile?.basename ?? "Open markdown file";
		breadcrumbs.push({
			label: rootLabel,
			isCurrent: this.currentScopeId === "scope:root" && this.sourceTrail.length === 0,
			onClick:
				this.currentFile && this.currentScopeId !== "scope:root"
					? async () => {
							this.currentScopeId = "scope:root";
							this.fittedScopeId = null;
							await this.renderCurrentFile();
						}
					: undefined
		});

		const pathSegments = getScopePathSegments(scope?.id ?? this.currentScopeId);
		pathSegments.forEach((segment, index) => {
			const targetScopeId = `scope:${pathSegments.slice(0, index + 1).join(" > ")}`;
			const isCurrent = targetScopeId === this.currentScopeId;
			breadcrumbs.push({
				label: segment,
				isCurrent,
				onClick: isCurrent
					? undefined
					: async () => {
							this.currentScopeId = targetScopeId;
							this.fittedScopeId = null;
							await this.renderCurrentFile();
						}
			});
		});

		if (breadcrumbs.length) {
			breadcrumbs[breadcrumbs.length - 1].isCurrent = true;
		}

		return breadcrumbs;
	}

	private renderToolbar(scope?: ParsedScope) {
		this.toolbarBreadcrumbsEl.empty();
		const breadcrumbs = this.buildBreadcrumbs(scope);

		breadcrumbs.forEach((breadcrumb, index) => {
			if (index > 0) {
				this.toolbarBreadcrumbsEl.createSpan({
					cls: "arkidian-breadcrumb-separator",
					text: "/"
				});
			}

			const crumb = createInteractiveControl(this.toolbarBreadcrumbsEl, {
				cls: `arkidian-breadcrumb${breadcrumb.isCurrent ? " is-current" : ""}`,
				text: breadcrumb.label
			});
			setInteractiveDisabled(crumb, !breadcrumb.onClick || breadcrumb.isCurrent);
			const onClick = breadcrumb.onClick;
			if (onClick) {
				crumb.addEventListener("click", () => {
					if (breadcrumb.isCurrent) {
						return;
					}
					void onClick();
				});
			}
		});

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

	private renderEmptyState(stageEl: HTMLElement, message: string) {
		const empty = stageEl.createDiv({ cls: "arkidian-empty" });
		empty.setText(message);
	}

	private enableCanvasPanning() {
		this.viewportController.enablePanning({
			scrollEl: this.scrollEl,
			stageViewportEl: this.stageViewportEl,
			stageEl: this.stageEl,
			isSpacePressed: () => this.isSpacePressed,
			clearSelection: () => this.clearSelectedItem(),
			createHeading: () => {
				void this.createHeadingAtCurrentScope();
			}
		});
	}

	private handleCanvasWheel(event: WheelEvent) {
		if (!(event.ctrlKey || event.metaKey)) {
			return;
		}

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
		return this.viewportController.getMinZoom(viewportWidth, viewportHeight);
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
		return this.viewportController.getStagePointFromViewport({
			scrollLeft: this.scrollEl.scrollLeft,
			scrollTop: this.scrollEl.scrollTop,
			viewportX,
			viewportY,
			offsetX: this.viewportOffsetX,
			offsetY: this.viewportOffsetY,
			zoom: this.zoom
		});
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
		return this.viewportController.solveAxis(
			scaledStagePoint,
			viewportPoint,
			scaledStageSize,
			viewportSize
		);
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
		this.gridRenderer.render(this.gridCanvasEl, this.canvasEl, {
			zoom: this.zoom,
			scrollLeft: this.scrollEl.scrollLeft,
			scrollTop: this.scrollEl.scrollTop,
			viewportOffsetX: this.viewportOffsetX,
			viewportOffsetY: this.viewportOffsetY,
			devicePixelRatio: window.devicePixelRatio || 1
		});
	}
	private async renderFrontmatterCard(
		stageEl: HTMLElement,
		frontmatter: FrontmatterItem,
		state: CanvasItemState
	) {
		const card = stageEl.createDiv({
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
				if (existing?.key && persistedKey) {
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

	private selectItem(
		itemId: string,
		element: HTMLElement,
		options: { revealInLayer?: boolean; revealOnCanvas?: boolean } = {}
	) {
		const shouldRevealInLayer = options.revealInLayer ?? true;
		const shouldRevealOnCanvas = options.revealOnCanvas ?? false;
		if (shouldRevealInLayer && this.isLayerPanelCollapsed) {
			this.isLayerPanelCollapsed = false;
			this.syncLayerPanelPresentation();
		}
		if (shouldRevealInLayer) {
			this.expandLayerPathToItem(itemId);
		}
		this.selection.select(itemId, element);
		this.rerenderCurrentLayerPanel();
		this.revealSelectedLayerRow();
		if (shouldRevealOnCanvas) {
			this.revealCanvasElement(element);
		}
	}

	private selectItemById(
		itemId: string,
		options: { revealOnCanvas?: boolean } = {}
	) {
		const element =
			this.stageEl.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`) ??
			this.findRenderedEmbedElement(itemId);
		if (this.isLayerPanelCollapsed) {
			this.isLayerPanelCollapsed = false;
			this.syncLayerPanelPresentation();
		}
		this.expandLayerPathToItem(itemId);
		if (!element) {
			this.selection.selectMissingElement(itemId);
			this.rerenderCurrentLayerPanel();
			this.revealSelectedLayerRow();
			return;
		}
		this.selectItem(itemId, element, {
			revealInLayer: false,
			revealOnCanvas: options.revealOnCanvas ?? false
		});
	}

	private expandLayerPathToItem(itemId: string) {
		const tree = this.getCurrentLayerPanelTree();
		if (!tree) {
			return false;
		}

		const path = findLayerNodePathIds(tree, itemId);
		if (!path.length) {
			return false;
		}

		let changed = false;
		path.slice(0, -1).forEach((id) => {
			if (!this.expandedLayerIds.has(id)) {
				this.expandedLayerIds.add(id);
				changed = true;
			}
		});
		return changed;
	}

	private revealSelectedLayerRow() {
		this.layerPanelView.revealSelected();
	}

	private revealCanvasElement(element: HTMLElement) {
		this.runWhenCanvasReady(() => {
			const rect = element.getBoundingClientRect();
			const stageRect = this.stageViewportEl.getBoundingClientRect();
			if (!rect.width || !rect.height || !stageRect.width || !stageRect.height) {
				return;
			}

			const stageX = (rect.left + rect.width / 2 - stageRect.left) / this.zoom;
			const stageY = (rect.top + rect.height / 2 - stageRect.top) / this.zoom;
			const nextZoom = clamp(Math.max(this.zoom, 1), this.getMinZoom(), MAX_ZOOM);
			if (nextZoom !== this.zoom) {
				this.zoom = nextZoom;
				this.syncStageZoom();
			}
			this.positionViewportAroundStagePoint(
				stageX,
				stageY,
				this.scrollEl.clientWidth / 2,
				this.scrollEl.clientHeight / 2
			);
			this.scheduleGridRender();
		});
	}

	private findRenderedEmbedElement(embedId: string) {
		const embed = this.findEmbedById(embedId);
		if (!embed) {
			return null;
		}

		const escapedLink = cssEscape(embed.link);
		return this.stageEl.querySelector<HTMLElement>(
			`[data-embed-link="${escapedLink}"][data-embed-start-line="${embed.startLine}"]`
		);
	}

	private clearSelectedItem() {
		if (!this.selection.clear()) {
			return;
		}
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
			if (event.target instanceof Element && event.target.closest(".arkidian-card-resize-handle")) {
				return;
			}
			if (isInteractiveTarget(event.target)) {
				return;
			}
			event.preventDefault();
			this.selectItem(itemId, target);
			startX = event.clientX;
			startY = event.clientY;
			originX = state.x;
			originY = state.y;
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", onPointerUp);
		}, true);
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

		await this.sourceEditService.replaceSection(
			this.currentFile,
			section,
			nextContent
		);
	}

	private async renderMarkdownPreview(
		container: HTMLElement,
		markdown: string,
		embeds: EmbedNode[] = []
	) {
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
		this.decorateRenderedEmbeds(container, embeds);
	}

	private decorateRenderedEmbeds(container: HTMLElement, embeds: EmbedNode[]) {
		const renderedEmbeds = getRenderedEmbedElements(container);
		renderedEmbeds.forEach((element, index) => {
			const embed = embeds[index];
			if (!embed) {
				return;
			}

			element.dataset.itemId = embed.id;
			element.dataset.embedId = embed.id;
			element.dataset.embedLink = embed.link;
			element.dataset.embedStartLine = `${embed.startLine}`;
			element.addClass("arkidian-selectable-embed");
			element.setAttribute("role", "button");
			element.tabIndex = 0;
			element.setAttribute(
				"aria-label",
				`${getEmbedLayerLabel(embed)} embed`
			);
			element.addEventListener("pointerdown", (event) => {
				if (this.isSpacePressed || event.button !== 0) {
					return;
				}
				event.stopPropagation();
				this.selectItem(embed.id, element);
			}, true);
			element.addEventListener("click", (event) => {
				if (!(event.metaKey || event.ctrlKey)) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				void this.enterEmbed(embed);
			}, true);
			element.addEventListener("dblclick", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.openEmbedSource(embed);
			}, true);
			element.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					void this.enterEmbed(embed);
				}
			});
		});
	}

	private async openEmbedSource(embed: EmbedNode) {
		if (this.currentFile) {
			try {
				await this.app.workspace.openLinkText(embed.link, this.currentFile.path, "window", {
					active: true,
					state: {
						mode: "source"
					}
				});
				return;
			} catch (error) {
				console.error("Arkidian: failed to open embed via openLinkText", error);
			}
		}

		const resolved =
			embed.targetFilePath
				? {
						file: this.app.vault.getAbstractFileByPath(embed.targetFilePath),
						line: embed.targetLine ?? 0
					}
				: await this.resolveEmbedTarget(embed.link);

		if (resolved?.file instanceof TFile) {
			await this.openSourceInPopout(resolved.line ?? 0, resolved.file);
			return;
		}

		if (this.currentFile) {
			new Notice("Could not resolve the embed target. Opening the source note instead.");
			await this.openSourceInPopout(embed.startLine, this.currentFile);
		}
	}

	private async openSourceInPopout(line: number, file = this.currentFile) {
		return this.openSourceInPopoutWithSelection(line, file);
	}

	private async openSourceInPopoutWithSelection(
		line: number,
		file = this.currentFile,
		selection?: { fromCh: number; toCh: number }
	) {
		if (!file) {
			return;
		}

		try {
			const leaf = this.app.workspace.openPopoutLeaf();
			await leaf.openFile(file, {
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

			const from = { line, ch: selection?.fromCh ?? 0 };
			const to = { line, ch: selection?.toCh ?? from.ch };
			if (selection && editor.setSelection) {
				editor.setSelection(from, to);
			} else {
				editor.setCursor(from);
			}
			editor.scrollIntoView({ from, to }, true);
			editor.focus?.();

			const zoomPlugin = window.ObsidianZoomPlugin;
			if (!zoomPlugin) {
				return;
			}

			zoomPlugin.zoomIn(editor, line);
		} catch (error) {
			console.error("Arkidian: failed to open source in popout", error);
			new Notice("Could not open this source block in a new editor window.");
		}
	}

	private syncLayerPanelPresentation() {
		this.layerPanelEl.toggleClass("is-collapsed", this.isLayerPanelCollapsed);
		if (this.isLayerPanelCollapsed) {
			this.layerPanelEl.style.width = "";
			this.layerPanelEl.style.flexBasis = "";
		} else {
			this.layerPanelEl.style.width = `${this.layerPanelWidth}px`;
			this.layerPanelEl.style.flexBasis = `${this.layerPanelWidth}px`;
		}
		const toggle = this.layerPanelToggleEl;
		if (toggle) {
			setIcon(
				toggle,
				this.isLayerPanelCollapsed ? "panel-left-open" : "panel-left-close"
			);
			toggle.setAttribute(
				"aria-label",
				this.isLayerPanelCollapsed ? "Expand layer panel" : "Collapse layer panel"
			);
		}
		this.syncLayerHeadingTogglePresentation();
	}

	private enableLayerPanelResizing(handle: HTMLElement) {
		let startX = 0;
		let originWidth = this.layerPanelWidth;

		const onPointerMove = (event: PointerEvent) => {
			this.layerPanelWidth = clamp(
				originWidth + event.clientX - startX,
				MIN_LAYER_PANEL_WIDTH,
				MAX_LAYER_PANEL_WIDTH
			);
			this.syncLayerPanelPresentation();
		};

		const onPointerUp = () => {
			document.body.classList.remove("is-resizing-arkidian-layer-panel");
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
		};

		handle.addEventListener("pointerdown", (event) => {
			if (this.isLayerPanelCollapsed || event.button !== 0) {
				return;
			}

			event.preventDefault();
			startX = event.clientX;
			originWidth = this.layerPanelWidth;
			document.body.classList.add("is-resizing-arkidian-layer-panel");
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", onPointerUp);
		});
	}

	private toggleAllLayerHeadings() {
		const tree = this.getCurrentLayerPanelTree();
		if (!tree) {
			return;
		}

		const expandableIds = getExpandableLayerNodeIds(tree);
		const shouldExpand = expandableIds.some((id) => !this.expandedLayerIds.has(id));
		if (shouldExpand) {
			expandableIds.forEach((id) => this.expandedLayerIds.add(id));
		} else {
			expandableIds.forEach((id) => this.expandedLayerIds.delete(id));
		}
		this.rerenderCurrentLayerPanel();
	}

	private syncLayerHeadingTogglePresentation(tree = this.getCurrentLayerPanelTree()) {
		if (!this.layerPanelExpandAllEl) {
			return;
		}

		const expandableIds = tree ? getExpandableLayerNodeIds(tree) : [];
		const hasCollapsed = expandableIds.some((id) => !this.expandedLayerIds.has(id));
		const isDisabled = !expandableIds.length || this.isLayerPanelCollapsed;
		setIcon(this.layerPanelExpandAllEl, hasCollapsed ? "chevrons-down" : "chevrons-up");
		this.layerPanelExpandAllEl.setAttribute(
			"aria-label",
			hasCollapsed ? "Expand all headings" : "Collapse all headings"
		);
		setInteractiveDisabled(this.layerPanelExpandAllEl, isDisabled);
	}

	private getCurrentLayerPanelTree() {
		if (!this.parsedDocument) {
			return null;
		}

		const scope = this.parsedDocument.scopes[this.currentScopeId];
		if (!scope) {
			return null;
		}

		return this.buildLayerTree(
			scope.id,
			this.buildLayerPanelRenderableContexts(
				this.getRenderableItems(
					scope,
					this.getFrontmatterItem(scope),
					this.getLayerPanelOrphans(scope)
				)
			)
		);
	}

	private enableLayerRowReordering(row: HTMLElement, node: LayerTreeNode) {
		if (!this.canReorderLayerNode(node)) {
			return;
		}

		row.draggable = true;
		row.addEventListener("dragstart", (event) => {
			this.draggingLayerNodeId = node.id;
			row.addClass("is-dragging");
			event.dataTransfer?.setData("text/plain", node.id);
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = "move";
			}
		});
		row.addEventListener("dragend", () => {
			this.draggingLayerNodeId = null;
			row.removeClass("is-dragging");
			this.clearLayerDropIndicators();
		});
		row.addEventListener("dragover", (event) => {
			const position = this.getLayerDropPosition(row, event);
			if (!position || !this.canDropLayerNode(this.draggingLayerNodeId, node, position)) {
				return;
			}
			event.preventDefault();
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = "move";
			}
			this.showLayerDropIndicator(row, position);
		});
		row.addEventListener("dragleave", (event) => {
			const nextTarget = event.relatedTarget;
			if (nextTarget instanceof Node && row.contains(nextTarget)) {
				return;
			}
			row.removeClass("is-drop-before");
			row.removeClass("is-drop-after");
		});
		row.addEventListener("drop", (event) => {
			const position = this.getLayerDropPosition(row, event);
			if (!position || !this.canDropLayerNode(this.draggingLayerNodeId, node, position)) {
				return;
			}
			event.preventDefault();
			this.clearLayerDropIndicators();
			const draggedNodeId = this.draggingLayerNodeId;
			this.draggingLayerNodeId = null;
			if (!draggedNodeId) {
				return;
			}
			void this.moveLayerNode(draggedNodeId, node.id, position);
		});
	}

	private canReorderLayerNode(node: LayerTreeNode) {
		if (node.kind === "frontmatter" || node.kind === "embed") {
			return false;
		}
		if (
			node.id === "orphan:scope:root:file-title" ||
			node.id.endsWith(":scope-heading")
		) {
			return false;
		}
		return Boolean(node.sourceScopeId) && typeof node.startLine === "number";
	}

	private getLayerDropPosition(
		row: HTMLElement,
		event: DragEvent
	): "before" | "after" | null {
		const rect = row.getBoundingClientRect();
		if (!rect.height) {
			return null;
		}
		return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
	}

	private canDropLayerNode(
		draggedNodeId: string | null,
		targetNode: LayerTreeNode,
		position: "before" | "after"
	) {
		if (!draggedNodeId || draggedNodeId === targetNode.id || !this.parsedDocument) {
			return false;
		}

		const dragged = this.findLayerNodeById(draggedNodeId);
		if (!dragged || !this.canReorderLayerNode(dragged) || !this.canReorderLayerNode(targetNode)) {
			return false;
		}
		if (dragged.sourceScopeId !== targetNode.sourceScopeId) {
			return false;
		}

		const movableNodes = this.getMovableLayerNodesForScope(dragged.sourceScopeId ?? "");
		const draggedIndex = movableNodes.findIndex((node) => node.id === dragged.id);
		const targetIndex = movableNodes.findIndex((node) => node.id === targetNode.id);
		if (draggedIndex === -1 || targetIndex === -1) {
			return false;
		}
		if (position === "before" && draggedIndex === targetIndex - 1) {
			return false;
		}
		if (position === "after" && draggedIndex === targetIndex + 1) {
			return false;
		}
		return true;
	}

	private showLayerDropIndicator(row: HTMLElement, position: "before" | "after") {
		this.clearLayerDropIndicators();
		row.addClass(position === "before" ? "is-drop-before" : "is-drop-after");
	}

	private clearLayerDropIndicators() {
		this.layerTreeEl
			.querySelectorAll(".arkidian-layer-row.is-drop-before, .arkidian-layer-row.is-drop-after")
			.forEach((row) => {
				row.removeClass("is-drop-before");
				row.removeClass("is-drop-after");
			});
	}

	private findLayerNodeById(nodeId: string) {
		if (!this.parsedDocument) {
			return null;
		}

		const scope = this.parsedDocument.scopes[this.currentScopeId];
		if (!scope) {
			return null;
		}

		const visit = (nodes: LayerTreeNode[]): LayerTreeNode | null => {
			for (const node of nodes) {
				if (node.id === nodeId) {
					return node;
				}
				const child = visit(node.children);
				if (child) {
					return child;
				}
			}
			return null;
		};

		return visit(
			this.buildLayerTree(
				scope.id,
				this.buildLayerPanelRenderableContexts(
					this.getRenderableItems(
						scope,
						this.getFrontmatterItem(scope),
						this.getLayerPanelOrphans(scope)
					)
				)
			)
		);
	}

	private getMovableLayerNodesForScope(scopeId: string) {
		if (!this.parsedDocument) {
			return [];
		}

		const scope = this.parsedDocument.scopes[scopeId];
		if (!scope) {
			return [];
		}

		return this.buildLayerTree(
			scopeId,
			this.buildLayerPanelRenderableContexts(
				this.getRenderableItems(scope, this.getFrontmatterItem(scope), this.getLayerPanelOrphans(scope))
			)
		).filter((node) => this.canReorderLayerNode(node));
	}

	private async moveLayerNode(
		draggedNodeId: string,
		targetNodeId: string,
		position: "before" | "after"
	) {
		if (!this.currentFile || !this.parsedDocument) {
			return;
		}

		const dragged = this.findLayerNodeById(draggedNodeId);
		const target = this.findLayerNodeById(targetNodeId);
		const sourceScopeId = dragged?.sourceScopeId;
		if (!dragged || !target || !sourceScopeId || sourceScopeId !== target.sourceScopeId) {
			return;
		}

		const movableNodes = this.getMovableLayerNodesForScope(sourceScopeId);
		const draggedIndex = movableNodes.findIndex((node) => node.id === draggedNodeId);
		const targetIndex = movableNodes.findIndex((node) => node.id === targetNodeId);
		if (draggedIndex === -1 || targetIndex === -1) {
			return;
		}

		this.clearSelectedItem();
		this.suppressFileRefreshUntil = Date.now() + 800;
		const moved = await this.sourceEditService.moveLayerBlock(
			this.currentFile,
			movableNodes,
			draggedNodeId,
			targetNodeId,
			position
		);
		if (!moved) {
			return;
		}
		await this.renderCurrentFile();
	}

	private async createHeadingAtCurrentScope() {
		if (!this.currentFile) {
			return;
		}

		const source = await this.app.vault.read(this.currentFile);
		const parsed = parseMarkdownStructure(source);
		const scope = parsed.scopes[this.currentScopeId];
		if (!scope) {
			new Notice("Could not resolve the current canvas scope.");
			return;
		}

		this.suppressFileRefreshUntil = Date.now() + 500;
		const insertResult = await this.sourceEditService.insertHeading(
			this.currentFile,
			scope
		);
		await this.renderCurrentFile();
		await this.openSourceInPopoutWithSelection(
			insertResult.line ?? scope.insertLine,
			this.currentFile,
			insertResult.selection
		);
	}

	private getCurrentRenderableItem(itemId: string) {
		if (!this.parsedDocument) {
			return null;
		}

		const scope = this.parsedDocument.scopes[this.currentScopeId];
		if (!scope) {
			return null;
		}

		const renderables = this.getRenderableItems(
			scope,
			this.getFrontmatterItem(scope),
			this.getDisplayOrphans(scope)
		);
		return renderables.find((renderable) => renderable.id === itemId) ?? null;
	}

	private async deleteSelectedItem() {
		if (!this.currentFile || !this.selection.selectedItemId) {
			return;
		}

		const renderable = this.getCurrentRenderableItem(this.selection.selectedItemId);
		if (!renderable) {
			return;
		}

		if (renderable.kind === "frontmatter") {
			new Notice("Properties card cannot be deleted this way.");
			return;
		}

		if (
			renderable.kind === "orphan" &&
			(renderable.item.id === "orphan:scope:root:file-title" ||
				renderable.item.id.endsWith(":scope-heading"))
		) {
			new Notice("This generated heading card cannot be deleted this way.");
			return;
		}

		const startLine = renderable.item.startLine;
		const endLine = renderable.item.endLine;

		this.clearSelectedItem();
		this.suppressFileRefreshUntil = Date.now() + 800;
		await this.sourceEditService.deleteRange(this.currentFile, startLine, endLine);
		await this.removeDeletedItemMeta(renderable);
		await this.renderCurrentFile();
	}

	private async removeDeletedItemMeta(
		renderable: Exclude<RenderableScopeItem, { kind: "frontmatter" }>
	) {
		if (!this.currentFile) {
			return;
		}

		const timer = this.saveTimers.get(renderable.id);
		if (timer) {
			window.clearTimeout(timer);
			this.saveTimers.delete(renderable.id);
		}

		const meta = await this.readMeta(this.currentFile);
		const scopeMeta = meta.scopes[this.currentScopeId];
		let changed = false;

		if (
			scopeMeta &&
			Object.prototype.hasOwnProperty.call(scopeMeta.items, renderable.id)
		) {
			delete scopeMeta.items[renderable.id];
			changed = true;
		}

		const childScopeId =
			renderable.kind === "section"
				? renderable.item.scopeId
				: renderable.item.childScopeId;
		if (childScopeId) {
			const scopeCount = Object.keys(meta.scopes).length;
			removeScopeMetaTree(meta, childScopeId);
			changed = changed || Object.keys(meta.scopes).length !== scopeCount;
		}

		if (changed) {
			await this.writeMeta(meta);
		}
	}

	private async openCanvasLocation(filePath: string, scopeId: string) {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			new Notice("Could not resolve the target note for this canvas entry.");
			return;
		}

		this.currentFile = file;
		this.currentScopeId = scopeId;
		this.fittedFilePath = null;
		this.fittedScopeId = null;
		await this.renderCurrentFile();
	}

	private async enterEmbed(embed: EmbedNode) {
		if (!embed.targetFilePath) {
			new Notice("Could not resolve the embedded note.");
			return;
		}

		this.sourceTrail = [
			...this.sourceTrail,
			{
				label: embed.label,
				sourceFilePath: this.currentFile?.path ?? embed.targetFilePath,
				sourceScopeId: this.currentScopeId,
				sourceLine: embed.startLine,
				targetFilePath: embed.targetFilePath,
				targetScopeId: embed.targetScopeId ?? "scope:root"
			}
		];
		await this.openCanvasLocation(
			embed.targetFilePath,
			embed.targetScopeId ?? "scope:root"
		);
	}

	private async enterScope(scopeId: string) {
		this.currentScopeId = scopeId;
		this.fittedScopeId = null;
		await this.renderCurrentFile();
	}

	private getScopeMeta(meta: CanvasMeta, scopeId: string) {
		return this.metaStore.getScopeMeta(meta, scopeId);
	}

	private async readMeta(file: TFile): Promise<CanvasMeta> {
		return this.metaStore.read(file);
	}

	private async writeMeta(meta: CanvasMeta) {
		if (!this.currentFile) {
			return;
		}

		await this.metaStore.write(this.currentFile, meta);
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

	private getDefaultItemStates(
		contexts: RenderableItemContext[]
	): Record<string, CanvasItemState> {
		const supportX = -620;
		const supportY = -240;
		const supportSpacingY = 190;
		const sectionX = 0;
		const sectionY = -240;
		const sectionSpacingX = 593;
		const states: Record<string, CanvasItemState> = {};
		const supportItems = contexts
			.map((context) => context.renderable)
			.filter((renderable) => renderable.kind !== "section")
			.sort((a, b) => this.getSupportLayoutPriority(a) - this.getSupportLayoutPriority(b));
		const sectionItems = contexts
			.map((context) => context.renderable)
			.filter((renderable) => renderable.kind === "section");

		for (const [index, renderable] of supportItems.entries()) {
			states[renderable.id] = {
				id: renderable.id,
				x: supportX,
				y: supportY + index * supportSpacingY,
				width: renderable.kind === "frontmatter" ? 520 : DEFAULT_CARD_WIDTH,
				height: renderable.kind === "frontmatter" ? DEFAULT_CARD_HEIGHT : 140
			};
		}

		for (const [index, renderable] of sectionItems.entries()) {
			states[renderable.id] = {
				id: renderable.id,
				x: sectionX + index * sectionSpacingX,
				y: sectionY,
				width: DEFAULT_CARD_WIDTH,
				height: DEFAULT_CARD_HEIGHT
			};
		}

		return states;
	}

	private getSupportLayoutPriority(renderable: RenderableScopeItem) {
		if (renderable.kind === "orphan" && renderable.id === "orphan:scope:root:file-title") {
			return -2;
		}
		if (renderable.kind === "frontmatter") {
			return -1;
		}
		return renderable.startLine;
	}
}

