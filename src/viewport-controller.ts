import {
	MAX_ZOOM,
	MIN_SCROLLABLE_OVERFLOW,
	MIN_ZOOM,
	STAGE_HEIGHT,
	STAGE_WIDTH
} from "./constants";
import { clamp } from "./domain";

export class ViewportController {
	enablePanning(params: {
		scrollEl: HTMLElement;
		stageViewportEl: HTMLElement;
		stageEl: HTMLElement;
		isSpacePressed(): boolean;
		clearSelection(): void;
		createHeading(): void;
	}) {
		let startX = 0;
		let startY = 0;
		let originScrollLeft = 0;
		let originScrollTop = 0;
		let isPanning = false;

		const onPointerMove = (event: PointerEvent) => {
			if (!isPanning) {
				return;
			}

			params.scrollEl.scrollLeft = originScrollLeft - (event.clientX - startX);
			params.scrollEl.scrollTop = originScrollTop - (event.clientY - startY);
		};

		const onPointerUp = () => {
			isPanning = false;
			params.scrollEl.removeClass("is-panning");
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
		};

		params.scrollEl.addEventListener("pointerdown", (event) => {
			if (
				event.target === params.scrollEl ||
				event.target === params.stageViewportEl ||
				event.target === params.stageEl
			) {
				params.clearSelection();
			}

			const isSpaceDrag = params.isSpacePressed() && event.button === 0;
			const isMiddleDrag = event.button === 1;
			if (!isSpaceDrag && !isMiddleDrag) {
				return;
			}

			event.preventDefault();
			isPanning = true;
			startX = event.clientX;
			startY = event.clientY;
			originScrollLeft = params.scrollEl.scrollLeft;
			originScrollTop = params.scrollEl.scrollTop;
			params.scrollEl.addClass("is-panning");
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", onPointerUp);
		});
		params.scrollEl.addEventListener("auxclick", (event) => {
			if (event.button === 1) {
				event.preventDefault();
			}
		});
		params.scrollEl.addEventListener("dblclick", (event) => {
			if (
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.shiftKey
			) {
				return;
			}

			if (
				event.target !== params.scrollEl &&
				event.target !== params.stageViewportEl &&
				event.target !== params.stageEl
			) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			params.createHeading();
		});
	}

	getMinZoom(viewportWidth: number, viewportHeight: number) {
		const minScrollableZoom = Math.max(
			(Math.max(1, viewportWidth) + MIN_SCROLLABLE_OVERFLOW) / STAGE_WIDTH,
			(Math.max(1, viewportHeight) + MIN_SCROLLABLE_OVERFLOW) / STAGE_HEIGHT
		);

		return clamp(minScrollableZoom, MIN_ZOOM, MAX_ZOOM);
	}

	getStagePointFromViewport(params: {
		scrollLeft: number;
		scrollTop: number;
		viewportX: number;
		viewportY: number;
		offsetX: number;
		offsetY: number;
		zoom: number;
	}) {
		return {
			x: (params.scrollLeft + params.viewportX - params.offsetX) / params.zoom,
			y: (params.scrollTop + params.viewportY - params.offsetY) / params.zoom
		};
	}

	solveAxis(
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
}
