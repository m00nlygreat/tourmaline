import { clamp } from "./domain";
import type { LayerTreeNode, ParsedScope, SectionNode } from "./types";
import type { TFile, Vault } from "obsidian";

export type SourceEditResult = {
	markdown: string;
	line?: number;
	selection?: { fromCh: number; toCh: number };
};

export function replaceSectionContent(
	source: string,
	section: SectionNode,
	nextContent: string
): string {
	const lines = splitLines(source);
	const replacement = nextContent.replace(/\r\n/g, "\n").split("\n");
	return [
		...lines.slice(0, section.startLine),
		...replacement,
		...lines.slice(section.endLine + 1)
	].join("\n");
}

export function moveLayerBlock(
	source: string,
	movableNodes: LayerTreeNode[],
	draggedNodeId: string,
	targetNodeId: string,
	position: "before" | "after"
): string | null {
	const draggedIndex = movableNodes.findIndex((node) => node.id === draggedNodeId);
	const targetIndex = movableNodes.findIndex((node) => node.id === targetNodeId);
	if (draggedIndex === -1 || targetIndex === -1) {
		return null;
	}

	const lines = splitLines(source);
	const segments = movableNodes.map((node, index) => ({
		id: node.id,
		startLine: node.startLine,
		endLine:
			index < movableNodes.length - 1
				? movableNodes[index + 1].startLine - 1
				: node.endLine ?? node.startLine
	}));
	const draggedSegment = segments[draggedIndex];
	const targetSegment = segments[targetIndex];
	if (!draggedSegment || !targetSegment) {
		return null;
	}

	const block = lines.slice(draggedSegment.startLine, draggedSegment.endLine + 1);
	const remainingLines = [
		...lines.slice(0, draggedSegment.startLine),
		...lines.slice(draggedSegment.endLine + 1)
	];
	const blockLength = draggedSegment.endLine - draggedSegment.startLine + 1;
	let insertLine =
		position === "before"
			? targetSegment.startLine
			: targetSegment.endLine + 1;
	if (insertLine > draggedSegment.startLine) {
		insertLine -= blockLength;
	}
	insertLine = clamp(insertLine, 0, remainingLines.length);

	return [
		...remainingLines.slice(0, insertLine),
		...block,
		...remainingLines.slice(insertLine)
	].join("\n");
}

export function insertHeadingAtScope(
	source: string,
	scope: ParsedScope,
	headingTitle = "Untitled"
): SourceEditResult {
	const headingLevel = clamp(scope.canvasHeadingLevel, 1, 6);
	const headingPrefix = `${"#".repeat(headingLevel)} `;
	const headingLine = `${headingPrefix}${headingTitle}`;
	const lines = source.length ? splitLines(source) : [];
	const insertLine = clamp(scope.insertLine, 0, lines.length);
	const before = lines.slice(0, insertLine);
	const after = lines.slice(insertLine);
	const prefixBlank =
		before.length > 0 && before[before.length - 1].trim().length > 0 ? [""] : [];
	const insertedLine = before.length + prefixBlank.length;

	return {
		markdown: [
			...before,
			...prefixBlank,
			headingLine,
			"",
			"",
			...after
		].join("\n"),
		line: insertedLine,
		selection: {
			fromCh: headingPrefix.length,
			toCh: headingLine.length
		}
	};
}

export function deleteLineRange(source: string, startLine: number, endLine: number) {
	const lines = splitLines(source);
	return [
		...lines.slice(0, startLine),
		...lines.slice(endLine + 1)
	].join("\n");
}

function splitLines(source: string) {
	return source.split(/\r?\n/);
}

export class SourceEditService {
	constructor(private readonly vault: Vault) {}

	async replaceSection(file: TFile, section: SectionNode, nextContent: string) {
		const source = await this.vault.read(file);
		await this.vault.modify(file, replaceSectionContent(source, section, nextContent));
	}

	async moveLayerBlock(
		file: TFile,
		movableNodes: LayerTreeNode[],
		draggedNodeId: string,
		targetNodeId: string,
		position: "before" | "after"
	) {
		const source = await this.vault.read(file);
		const nextMarkdown = moveLayerBlock(
			source,
			movableNodes,
			draggedNodeId,
			targetNodeId,
			position
		);
		if (nextMarkdown === null) {
			return false;
		}

		await this.vault.modify(file, nextMarkdown);
		return true;
	}

	async insertHeading(file: TFile, scope: ParsedScope) {
		const source = await this.vault.read(file);
		const result = insertHeadingAtScope(source, scope);
		await this.vault.modify(file, result.markdown);
		return result;
	}

	async deleteRange(file: TFile, startLine: number, endLine: number) {
		const source = await this.vault.read(file);
		await this.vault.modify(file, deleteLineRange(source, startLine, endLine));
	}
}
