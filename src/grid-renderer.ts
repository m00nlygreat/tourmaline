import {
	GRID_DOT_RADIUS,
	GRID_SPACING,
	MIN_GRID_SCREEN_SPACING,
	STAGE_HEIGHT,
	STAGE_WIDTH
} from "./constants";
import { mod } from "./domain";

export type GridRenderState = {
	zoom: number;
	scrollLeft: number;
	scrollTop: number;
	viewportOffsetX: number;
	viewportOffsetY: number;
	devicePixelRatio: number;
};

export class GridRenderer {
	render(canvas: HTMLCanvasElement, host: HTMLElement, state: GridRenderState) {
		const width = Math.max(1, Math.floor(host.clientWidth));
		const height = Math.max(1, Math.floor(host.clientHeight));
		const dpr = state.devicePixelRatio || 1;
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

		const dotColor = getComputedStyle(host)
			.getPropertyValue("--arkidian-grid-dot-color")
			.trim() || "rgba(128, 128, 128, 0.32)";
		const baseSpacing = GRID_SPACING * state.zoom;
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
			originX * state.zoom - state.scrollLeft + state.viewportOffsetX;
		const screenOriginY =
			originY * state.zoom - state.scrollTop + state.viewportOffsetY;
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
}
