import {
	DEFAULT_CARD_HEIGHT,
	MAX_CARD_WIDTH,
	MIN_CARD_WIDTH
} from "./constants";
import {
	applyItemFrame,
	clamp,
	shouldIgnoreCardActivation
} from "./domain";
import type { CanvasItemState, EmbedNode, OrphanNode, SectionNode } from "./types";

export type CardRendererOptions = {
	renderMarkdownPreview(
		container: HTMLElement,
		markdown: string,
		embeds: EmbedNode[]
	): Promise<void>;
	enableItemSelection(target: HTMLElement, itemId: string): void;
	persistItemState(itemId: string, state: CanvasItemState): void;
	enterScope(scopeId: string): void;
	openSource(line: number): void;
	getZoom(): number;
	isSpacePressed(): boolean;
	selectItem(itemId: string, element: HTMLElement): void;
};

export class CardRenderer {
	constructor(private readonly options: CardRendererOptions) {}

	async renderSectionCard(
		stageEl: HTMLElement,
		section: SectionNode,
		state: CanvasItemState,
		embeds: EmbedNode[]
	) {
		const card = stageEl.createDiv({ cls: "arkidian-card" });
		this.options.enableItemSelection(card, section.id);
		applyItemFrame(card, state);

		const body = card.createDiv({ cls: "arkidian-card-body" });
		const preview = body.createDiv({ cls: "arkidian-preview" });
		await this.options.renderMarkdownPreview(preview, section.content, embeds);
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
			this.options.enterScope(section.scopeId);
		});
		card.addEventListener("dblclick", (event) => {
			if (shouldIgnoreCardActivation(event.target)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			this.options.openSource(section.startLine);
		});

		this.enableDragging(card, card, section.id, state);
		this.enableCardResizing(card, section.id, state);
	}

	async renderOrphan(
		stageEl: HTMLElement,
		orphan: OrphanNode,
		state: CanvasItemState,
		embeds: EmbedNode[]
	) {
		const item = stageEl.createDiv({ cls: "arkidian-orphan" });
		this.options.enableItemSelection(item, orphan.id);
		item.toggleClass("is-drillable", Boolean(orphan.childScopeId));
		applyItemFrame(item, state);

		const preview = item.createDiv({ cls: "arkidian-preview" });
		await this.options.renderMarkdownPreview(preview, orphan.content.trim(), embeds);
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
			this.options.enterScope(orphan.childScopeId);
		});
		item.addEventListener("dblclick", (event) => {
			if (shouldIgnoreCardActivation(event.target)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			this.options.openSource(orphan.startLine);
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
			const deltaX = (event.clientX - startX) / this.options.getZoom();
			const deltaY = (event.clientY - startY) / this.options.getZoom();
			state.x = originX + deltaX;
			state.y = originY + deltaY;
			applyItemFrame(target, state);
		};

		const onPointerUp = () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			this.options.persistItemState(itemId, state);
		};

		handle.addEventListener("pointerdown", (event) => {
			if (this.options.isSpacePressed() || event.button !== 0) {
				return;
			}
			if (event.target instanceof Element && event.target.closest(".arkidian-card-resize-handle")) {
				return;
			}
			event.preventDefault();
			this.options.selectItem(itemId, target);
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
			const deltaX = (event.clientX - startX) / this.options.getZoom();
			state.width = clamp(originWidth + deltaX, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
			applyItemFrame(card, state);
		};

		const onPointerUp = () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			this.options.persistItemState(itemId, state);
		};

		resizeHandle.addEventListener("pointerdown", (event) => {
			if (this.options.isSpacePressed() || event.button !== 0) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			this.options.selectItem(itemId, card);
			startX = event.clientX;
			originWidth = state.width;
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", onPointerUp);
		});
	}
}
