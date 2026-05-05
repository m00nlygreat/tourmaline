import { describe, expect, it } from "vitest";
import {
	deleteLineRange,
	insertHeadingAtScope,
	moveLayerBlock,
	replaceSectionContent
} from "../src/source-transforms";
import type { LayerTreeNode, ParsedScope, SectionNode } from "../src/types";

describe("source transforms", () => {
	it("replaces a section source range", () => {
		const section = sectionNode({ startLine: 1, endLine: 2 });

		expect(replaceSectionContent("# A\nold\nbody\n# B", section, "new")).toBe(
			"# A\nnew\n# B"
		);
	});

	it("moves a source block before another layer node", () => {
		const source = "# A\nA\n# B\nB\n# C\nC";
		const nodes = [
			layerNode("a", 0, 1),
			layerNode("b", 2, 3),
			layerNode("c", 4, 5)
		];

		expect(moveLayerBlock(source, nodes, "c", "a", "before")).toBe(
			"# C\nC\n# A\nA\n# B\nB"
		);
	});

	it("inserts a heading at the current scope insert line", () => {
		const scope = parsedScope({ insertLine: 1, canvasHeadingLevel: 2 });
		const result = insertHeadingAtScope("# A\nBody", scope);

		expect(result.markdown).toBe("# A\n\n## Untitled\n\n\nBody");
		expect(result.line).toBe(2);
		expect(result.selection).toEqual({ fromCh: 3, toCh: 11 });
	});

	it("deletes an inclusive line range", () => {
		expect(deleteLineRange("a\nb\nc\nd", 1, 2)).toBe("a\nd");
	});
});

function sectionNode(overrides: Partial<SectionNode>): SectionNode {
	return {
		id: "section:a",
		title: "A",
		level: 1,
		path: ["A"],
		startLine: 0,
		endLine: 0,
		content: "",
		scopeId: "scope:A",
		...overrides
	};
}

function layerNode(id: string, startLine: number, endLine: number): LayerTreeNode {
	return {
		id,
		label: id,
		icon: "heading",
		kind: "section",
		startLine,
		endLine,
		sourceScopeId: "scope:root",
		children: []
	};
}

function parsedScope(overrides: Partial<ParsedScope>): ParsedScope {
	return {
		id: "scope:root",
		title: "Global",
		startLine: 0,
		endLine: 1,
		depth: 1,
		headingLevel: null,
		canvasHeadingLevel: 1,
		insertLine: 0,
		sections: [],
		orphans: [],
		...overrides
	};
}
