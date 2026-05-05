import { describe, expect, it } from "vitest";
import { ViewportController } from "../src/viewport-controller";

describe("ViewportController", () => {
	it("keeps the minimum zoom above the no-scroll collapse point", () => {
		const controller = new ViewportController();

		expect(controller.getMinZoom(1400, 900)).toBeGreaterThan(0.1);
	});

	it("resolves the stage point under a viewport coordinate", () => {
		const controller = new ViewportController();

		expect(
			controller.getStagePointFromViewport({
				scrollLeft: 120,
				scrollTop: 80,
				viewportX: 30,
				viewportY: 20,
				offsetX: 10,
				offsetY: 5,
				zoom: 2
			})
		).toEqual({ x: 70, y: 47.5 });
	});

	it("solves scroll and slack offset for anchored zoom", () => {
		const controller = new ViewportController();

		expect(controller.solveAxis(500, 100, 1000, 300)).toEqual({
			scroll: 400,
			offset: 0
		});
		expect(controller.solveAxis(50, 100, 80, 300)).toEqual({
			scroll: 0,
			offset: 50
		});
	});
});
