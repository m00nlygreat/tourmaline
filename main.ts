import {
	App,
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	ViewStateResult,
	WorkspaceLeaf
} from "obsidian";
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
	private backButtonEl!: HTMLButtonElement;
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
	private isSpacePressed = false;
	private fittedFilePath: string | null = null;
	private fittedScopeId: string | null = null;
	private gridRenderFrame: number | null = null;
	private resizeObserver: ResizeObserver | null = null;

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
		this.backButtonEl = this.toolbarActionsEl.createEl("button", { text: "Back" });
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
		const refreshButton = this.toolbarActionsEl.createEl("button", {
			text: "Refresh"
		});
		refreshButton.addEventListener("click", () => {
			this.fittedFilePath = null;
			this.fittedScopeId = null;
			void this.renderCurrentFile();
		});

		const openActiveButton = this.toolbarActionsEl.createEl("button", {
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

		this.canvasEl = this.containerEl.createDiv({ cls: "arkidian-canvas" });
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
		const meta = await this.readMeta(this.currentFile);
		const scopeMeta = this.getScopeMeta(meta, this.currentScopeId);
		const itemStates: CanvasItemState[] = [];
		this.renderToolbar(scope);

		if (!scope.sections.length && !scopeOrphans.length) {
			this.renderEmptyState("This document has no visible markdown blocks yet.");
			this.fitViewportToOriginIfNeeded();
			return;
		}

		for (const [index, section] of scope.sections.entries()) {
			const fallback = this.getDefaultItemState(section.id, index, false);
			const state = scopeMeta.items[section.id] ?? fallback;
			itemStates.push(state);
			await this.renderSectionCard(section, state);
		}

		for (const [index, orphan] of scopeOrphans.entries()) {
			const fallback = this.getDefaultItemState(orphan.id, index, true);
			const state = scopeMeta.items[orphan.id] ?? fallback;
			itemStates.push(state);
			await this.renderOrphan(orphan, state);
		}

		meta.scopes[this.currentScopeId] = {
			zoom: scopeMeta.zoom,
			items: {
				...Object.fromEntries(
					[...scope.sections, ...scopeOrphans].map((node, index) => {
						const fallback = this.getDefaultItemState(
							node.id,
							index,
							"id" in node && node.id.startsWith("orphan")
						);
						return [node.id, scopeMeta.items[node.id] ?? fallback];
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

	private renderToolbar(scope?: ParsedScope) {
		this.toolbarBreadcrumbsEl.empty();

		const rootLabel = this.currentFile?.basename ?? "Open markdown file";
		const rootButton = this.toolbarBreadcrumbsEl.createEl("button", {
			cls: `arkidian-breadcrumb${this.currentScopeId === "scope:root" ? " is-current" : ""}`,
			text: rootLabel
		});
		rootButton.disabled = !this.currentFile || this.currentScopeId === "scope:root";
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
			const crumb = this.toolbarBreadcrumbsEl.createEl("button", {
				cls: `arkidian-breadcrumb${isCurrent ? " is-current" : ""}`,
				text: segment
			});
			crumb.disabled = isCurrent;
			crumb.addEventListener("click", () => {
				if (isCurrent) {
					return;
				}
				this.currentScopeId = targetScopeId;
				this.fittedScopeId = null;
				void this.renderCurrentFile();
			});
		});

		this.backButtonEl.disabled = this.currentScopeId === "scope:root";
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
		applyItemFrame(card, state);

		const body = card.createDiv({ cls: "arkidian-card-body" });
		const preview = body.createDiv({ cls: "arkidian-preview" });
		await this.renderMarkdownPreview(preview, section.content);
		state.height = Math.max(DEFAULT_CARD_HEIGHT, Math.ceil(card.offsetHeight));
		applyItemFrame(card, state);
		card.addEventListener("dblclick", (event) => {
			if (shouldIgnoreCardActivation(event.target)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if (event.metaKey || event.ctrlKey) {
				void this.enterScope(section.scopeId);
				return;
			}
			void this.openSourceInPopout(section.startLine);
		});

		this.enableDragging(card, card, section.id, state);
		this.enableCardResizing(card, section.id, state);
	}

	private async renderOrphan(orphan: OrphanNode, state: CanvasItemState) {
		const item = this.stageEl.createDiv({ cls: "arkidian-orphan" });
		item.toggleClass("is-drillable", Boolean(orphan.childScopeId));
		applyItemFrame(item, state);

		const preview = item.createDiv({ cls: "arkidian-preview" });
		await this.renderMarkdownPreview(preview, orphan.content.trim());
		state.height = Math.max(1, Math.ceil(item.offsetHeight));
		applyItemFrame(item, state);
		item.addEventListener("dblclick", (event) => {
			if (shouldIgnoreCardActivation(event.target)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if ((event.metaKey || event.ctrlKey) && orphan.childScopeId) {
				void this.enterScope(orphan.childScopeId);
				return;
			}
			void this.openSourceInPopout(orphan.startLine);
		});

		this.enableDragging(item, item, orphan.id, state);
		this.enableCardResizing(item, orphan.id, state);
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
		isOrphan: boolean
	): CanvasItemState {
		const cardSpacingX = 460;
		const cardSpacingY = 380;
		const orphanSpacingY = 190;
		const column = index % 3;
		const row = Math.floor(index / 3);

		return {
			id,
			x: isOrphan ? -DEFAULT_CARD_WIDTH - 220 : (column - 1) * cardSpacingX,
			y: isOrphan
				? -DEFAULT_CARD_HEIGHT / 2 + index * orphanSpacingY
				: (row - 1) * cardSpacingY,
			width: DEFAULT_CARD_WIDTH,
			height: isOrphan ? 140 : DEFAULT_CARD_HEIGHT
		};
	}
}

function parseMarkdownStructure(markdown: string): ParsedDocument {
	const tree = unified().use(remarkParse).parse(markdown) as Root;
	const lines = markdown.split(/\r?\n/);
	const scopes: Record<string, ParsedScope> = {};
	const allHeadings = tree.children.filter(
		(node): node is Heading => node.type === "heading"
	);
	buildScope(tree.children, "scope:root", "Global", [], scopes, markdown, lines);
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
				scopes
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
				scopes
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
				startLine: getNodeStartLine(node),
				endLine: getScopeEndLine(bodyNodes, node, lines),
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
				node
			);
		});
	}

	scopes[scopeId] = {
		id: scopeId,
		title,
		startLine: nodes.length ? getNodeStartLine(nodes[0]) : 0,
		endLine: nodes.length ? getNodeEndLine(nodes[nodes.length - 1]) : 0,
		depth: minDepth,
		sections: scopeSections,
		orphans: scopeOrphans
	};
}

function createScopeHeadingOrphan(
	heading: Heading,
	scopeId: string,
	markdown: string,
	lines: string[]
): OrphanNode {
	return {
		id: `orphan:${scopeId}:scope-heading`,
		content: getNodeMarkdown(markdown, lines, heading),
		startLine: getNodeStartLine(heading),
		endLine: getNodeEndLine(heading),
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
	scopes: Record<string, ParsedScope>
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
				startLine: getNodeStartLine(nodes[0]),
				endLine: getNodeEndLine(nodes[nodes.length - 1]),
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
			startLine: getNodeStartLine(prefix[0]),
			endLine: getNodeEndLine(prefix[prefix.length - 1]),
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
			node
		);

		orphans.push({
			id: `orphan:${scopeId}:${label}`,
			content: groupNodes
				.map((groupNode) => getNodeMarkdown(markdown, lines, groupNode))
				.join("\n\n"),
			startLine: getNodeStartLine(groupNodes[0]),
			endLine: getNodeEndLine(groupNodes[groupNodes.length - 1]),
			scopeId,
			childScopeId
		});
	});

	return orphans.filter((orphan) => orphan.content.trim().length > 0);
}

function getScopeEndLine(nodes: Content[], heading: Heading, lines: string[]) {
	if (!nodes.length) {
		return Math.max(getNodeStartLine(heading), getNodeEndLine(heading));
	}
	return Math.max(
		getNodeEndLine(nodes[nodes.length - 1]),
		getNodeEndLine(heading),
		lines.length - 1
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

function getNodeStartLine(node: Content | Heading) {
	return Math.max(0, (node.position?.start.line ?? 1) - 1);
}

function getNodeEndLine(node: Content | Heading) {
	return Math.max(getNodeStartLine(node), (node.position?.end.line ?? 1) - 1);
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
