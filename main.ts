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
const STAGE_WIDTH = 14000;
const STAGE_HEIGHT = 9000;
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
		const refreshButton = toolbar.createEl("button", { text: "Refresh" });
		refreshButton.addEventListener("click", () => {
			this.fittedFilePath = null;
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
			this.fittedFilePath = null;
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
		const itemStates: CanvasItemState[] = [];

		if (!parsed.sections.length && !parsed.orphans.length) {
			this.renderEmptyState("This document has no visible markdown blocks yet.");
			this.fitViewportToOriginIfNeeded();
			return;
		}

		parsed.sections.forEach((section, index) => {
			const fallback = this.getDefaultItemState(section.id, index, false);
			const state = meta.items[section.id] ?? fallback;
			itemStates.push(state);
			this.renderSectionCard(section, state);
		});

		parsed.orphans.forEach((orphan, index) => {
			const fallback = this.getDefaultItemState(orphan.id, index, true);
			const state = meta.items[orphan.id] ?? fallback;
			itemStates.push(state);
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

		this.fitViewportToItemsIfNeeded(itemStates, meta.zoom || 1);
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
			if (!this.isSpacePressed || event.button !== 0) {
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
		if (!this.currentFile || this.fittedFilePath === this.currentFile.path) {
			return;
		}

		this.runWhenCanvasReady(() => {
			this.zoom = 1;
			this.syncStageZoom();
			this.centerOnWorldPoint(0, 0);
			this.fittedFilePath = this.currentFile?.path ?? null;
		});
	}

	private fitViewportToItemsIfNeeded(
		itemStates: CanvasItemState[],
		fallbackZoom: number
	) {
		if (!this.currentFile || this.fittedFilePath === this.currentFile.path) {
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

	private async persistZoomState() {
		if (!this.currentFile) {
			return;
		}

		const meta = await this.readMeta(this.currentFile);
		meta.zoom = this.zoom;
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
	element.style.left = `${STAGE_WIDTH / 2 + state.x}px`;
	element.style.top = `${STAGE_HEIGHT / 2 + state.y}px`;
	element.style.width = `${state.width}px`;
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
