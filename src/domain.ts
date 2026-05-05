import { getFrontMatterInfo, resolveSubpath } from "obsidian";
import type { Content, Heading, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type {
	CanvasItemState,
	CanvasMeta,
	EmbedNode,
	LayerTreeNode,
	OrphanNode,
	ParsedDocument,
	ParsedScope,
	RenderableScopeItem,
	SectionNode
} from "./types";
import { STAGE_HEIGHT, STAGE_WIDTH } from "./constants";
export function parseMarkdownStructure(markdown: string): ParsedDocument {
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

export function buildScope(
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
			createScopeHeadingOrphan(scopeHeading, scopeId, markdown, lines, lineOffset)
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
			const headingTitle = toString(node).trim();
			const previousSiblingCount = shellHeadings
				.slice(0, shellIndex)
				.filter(({ node: previousNode }) => toString(previousNode).trim() === headingTitle)
				.length;
			const shellPath = [
				...parentPath,
				previousSiblingCount > 0
					? `${headingTitle}~${previousSiblingCount + 1}`
					: headingTitle
			];
			const sectionId = `section:${shellPath.join(" > ")}`;
			const childScopeId = `scope:${shellPath.join(" > ")}`;
			const bodyNodes = nodes.slice(index + 1, nextShellIndex);

			scopeSections.push({
				id: sectionId,
				title: headingTitle,
				level: node.depth,
				path: shellPath,
				startLine: getNodeStartLine(node, lineOffset),
				endLine: getScopeEndLine(bodyNodes, node, lineOffset),
				content: [getNodeMarkdown(markdown, lines, node), ...bodyNodes.map((bodyNode) => getNodeMarkdown(markdown, lines, bodyNode))]
					.filter((part) => part.trim().length > 0)
					.join("\n\n"),
				scopeId: childScopeId
			});

			buildScope(
				bodyNodes,
				childScopeId,
				headingTitle,
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
		headingLevel: scopeHeading?.depth ?? null,
		canvasHeadingLevel:
			minDepth ?? Math.min(6, Math.max(1, (scopeHeading?.depth ?? 0) + 1)),
		insertLine: getScopeInsertLine(nodes, scopeHeading, lines, lineOffset),
		sections: scopeSections,
		orphans: scopeOrphans
	};
}

export function createScopeHeadingOrphan(
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

export function createFileTitleOrphan(fileName: string): OrphanNode {
	return {
		id: "orphan:scope:root:file-title",
		content: `# ${escapeMarkdownHeadingText(fileName)}`,
		startLine: 0,
		endLine: 0,
		scopeId: "scope:root"
	};
}

export function buildShellLessNodes(
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

export function getScopeEndLine(
	nodes: Content[],
	heading: Heading,
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
		getNodeEndLine(heading, lineOffset)
	);
}

export function getNodeMarkdown(markdown: string, lines: string[], node: Content | Heading) {
	const startOffset = node.position?.start.offset;
	const endOffset = node.position?.end.offset;
	if (typeof startOffset === "number" && typeof endOffset === "number") {
		return markdown.slice(startOffset, endOffset);
	}
	return lines
		.slice(getNodeStartLine(node), getNodeEndLine(node) + 1)
		.join("\n");
}

export function getNodeStartLine(node: Content | Heading, lineOffset = 0) {
	return Math.max(0, lineOffset + (node.position?.start.line ?? 1) - 1);
}

export function getNodeEndLine(node: Content | Heading, lineOffset = 0) {
	return Math.max(
		getNodeStartLine(node, lineOffset),
		lineOffset + (node.position?.end.line ?? 1) - 1
	);
}

export function getScopeInsertLine(
	nodes: Content[],
	heading: Heading | null,
	lines: string[],
	lineOffset: number
) {
	if (nodes.length) {
		return getNodeEndLine(nodes[nodes.length - 1], lineOffset) + 1;
	}

	if (heading) {
		return getNodeEndLine(heading, lineOffset) + 1;
	}

	return lineOffset + lines.length;
}

export function removeScopeMetaTree(meta: CanvasMeta, scopeId: string) {
	for (const key of Object.keys(meta.scopes)) {
		if (key === scopeId || key.startsWith(`${scopeId} >`) || key.startsWith(`${scopeId}:`)) {
			delete meta.scopes[key];
		}
	}
}

export function getParentScopeId(scopeId: string) {
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

export function getScopePathSegments(scopeId: string) {
	if (scopeId === "scope:root") {
		return [];
	}

	return scopeId
		.slice("scope:".length)
		.split(" > ")
		.filter((segment) => segment.length > 0);
}

export function escapeMarkdownHeadingText(text: string) {
	return text.replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
}

export function getLineCount(text: string) {
	if (!text.length) {
		return 0;
	}

	return text.split(/\r?\n/).length - 1;
}

export function extractLinkSubpath(link: string) {
	const hashIndex = link.indexOf("#");
	if (hashIndex === -1) {
		return null;
	}

	const subpath = link.slice(hashIndex);
	return subpath.length ? subpath : null;
}

export function normalizeEmbedBreadcrumbLabel(label: string) {
	return label.startsWith("![[") || label.startsWith("![")
		? label
		: `![[${label.replace(/^!+/, "")}]]`;
}

export function getFileNameFromPath(path: string) {
	const normalized = path.replace(/\\/g, "/");
	const segments = normalized.split("/");
	return segments[segments.length - 1] || path;
}

export function getResolvedSubpathStartLine(
	resolvedSubpath: ReturnType<typeof resolveSubpath>
) {
	if (!resolvedSubpath) {
		return 0;
	}

	return resolvedSubpath.start.line;
}

export function createInteractiveControl(
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

export function setInteractiveDisabled(control: HTMLElement, disabled: boolean) {
	control.toggleClass("is-disabled", disabled);
	control.setAttribute("aria-disabled", disabled ? "true" : "false");
	control.tabIndex = disabled ? -1 : 0;
}

export function stringifyFrontmatterValue(value: unknown) {
	if (typeof value === "string") {
		return value;
	}

	return JSON.stringify(value);
}

export function parseFrontmatterValue(value: string) {
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

export function getRenderableKindPriority(
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

export function dedupeEmbedsBySource(embeds: EmbedNode[]) {
	const seen = new Set<string>();
	const uniqueEmbeds: EmbedNode[] = [];
	for (const embed of embeds) {
		const key = `${embed.link}:${embed.startLine}:${embed.endLine}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		uniqueEmbeds.push(embed);
	}
	return uniqueEmbeds;
}

export function isEmbedInsideRenderable(
	embed: EmbedNode,
	renderable: Exclude<RenderableScopeItem, { kind: "frontmatter" }>
) {
	const { startLine, endLine } = getRenderableLineRange(renderable);
	return embed.startLine >= startLine && embed.endLine <= endLine;
}

export function getRenderableLineSpan(
	renderable: Exclude<RenderableScopeItem, { kind: "frontmatter" }>
) {
	const { startLine, endLine } = getRenderableLineRange(renderable);
	return Math.max(0, endLine - startLine);
}

export function getRenderableLineRange(
	renderable: Exclude<RenderableScopeItem, { kind: "frontmatter" }>
) {
	return {
		startLine: renderable.startLine,
		endLine:
			renderable.kind === "section"
				? renderable.item.endLine
				: renderable.item.endLine
	};
}

export function shouldFlattenOrphanLayerEmbeds(orphan: OrphanNode, embeds: EmbedNode[]) {
	if (!embeds.length) {
		return false;
	}

	const lines = orphan.content.split(/\r?\n/);
	for (const embed of embeds) {
		const start = Math.max(0, embed.startLine - orphan.startLine);
		const end = Math.min(lines.length - 1, embed.endLine - orphan.startLine);
		for (let index = start; index <= end; index += 1) {
			lines[index] = "";
		}
	}

	return lines.every((line) => line.trim().length === 0);
}

export function getOrphanLayerLabel(orphan: OrphanNode) {
	const firstMeaningfulLine = orphan.content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);

	if (!firstMeaningfulLine) {
		return "Untitled block";
	}

	const headingMatch = firstMeaningfulLine.match(/^#{1,6}\s+(.*)$/);
	const label = getDisplayLabelText(headingMatch?.[1] ?? firstMeaningfulLine);
	return label.length > 34 ? `${label.slice(0, 31).trimEnd()}...` : label;
}

export function mergeLayerChildren(
	descendantChildren: LayerTreeNode[],
	embedChildren: LayerTreeNode[]
) {
	return [...descendantChildren, ...embedChildren];
}

export function getExpandableLayerNodeIds(nodes: LayerTreeNode[]) {
	const ids: string[] = [];
	const visit = (node: LayerTreeNode) => {
		if (node.children.length) {
			ids.push(node.id);
			node.children.forEach(visit);
		}
	};
	nodes.forEach(visit);
	return ids;
}

export function findLayerNodePathIds(nodes: LayerTreeNode[], targetId: string) {
	const visit = (node: LayerTreeNode, path: string[]): string[] | null => {
		const nextPath = [...path, node.id];
		if (node.id === targetId) {
			return nextPath;
		}

		for (const child of node.children) {
			const match = visit(child, nextPath);
			if (match) {
				return match;
			}
		}
		return null;
	};

	for (const node of nodes) {
		const match = visit(node, []);
		if (match) {
			return match;
		}
	}
	return [];
}

export function getHeadingIcon(level: number) {
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

export function getOrphanLayerIcon(orphan: OrphanNode) {
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

export function getEmbedLayerLabel(embed: EmbedNode) {
	const label = getDisplayLabelText(
		embed.label || embed.original || normalizeEmbedBreadcrumbLabel(embed.link)
	);
	return label.length > 34 ? `${label.slice(0, 31).trimEnd()}...` : label;
}

export function getDisplayLabelText(text: string) {
	const normalized = text
		.replace(/^!?\[\[([^\]|]+)\|([^\]]+)\]\]$/g, "$2")
		.replace(/^!?\[\[([^\]]+)\]\]$/g, "$1")
		.replace(/^!\[([^\]]*)\]\(([^)]+)\)$/g, "$1 $2")
		.replace(/^\[([^\]]+)\]\(([^)]+)\)$/g, "$1")
		.replace(/^\[\]\(([^)]+)\)$/g, "$1")
		.replace(/^(?:[-*+]|\d+[.)])\s+/, "")
		.replace(/[`*_~]/g, "")
		.replace(/<([^>]+)>/g, "$1")
		.trim();

	return normalized.length ? normalized : "Untitled block";
}

export function cssEscape(value: string) {
	return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/"/g, '\\"');
}

export function applyItemFrame(element: HTMLElement, state: CanvasItemState) {
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

export function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

export function mod(value: number, divisor: number) {
	return ((value % divisor) + divisor) % divisor;
}

export function getItemBounds(itemStates: CanvasItemState[]) {
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

export function isTypingTarget(target: EventTarget | null) {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT")
	);
}

export function shouldIgnoreCardActivation(target: EventTarget | null) {
	return (
		target instanceof HTMLElement &&
		(Boolean(target.closest("a")) ||
			Boolean(target.closest("[data-embed-id]")) ||
			isTypingTarget(target))
	);
}

export function getRenderedEmbedElements(container: HTMLElement) {
	const embedSelector = ".internal-embed, .markdown-embed, .image-embed, .media-embed";
	const embedContainers = Array.from(
		container.querySelectorAll<HTMLElement>(embedSelector)
	).filter((element) => !element.parentElement?.closest(embedSelector));
	const standaloneImages = Array.from(
		container.querySelectorAll<HTMLImageElement>("img")
	).filter(
		(image) =>
			!image.closest(embedSelector) &&
			!embedContainers.some((element) => element.contains(image))
	);

	return [...embedContainers, ...standaloneImages].sort(
		(a, b) => compareDocumentPosition(a, b)
	);
}

export function compareDocumentPosition(a: HTMLElement, b: HTMLElement) {
	if (a === b) {
		return 0;
	}
	return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING
		? 1
		: -1;
}

export function isInteractiveTarget(target: EventTarget | null) {
	const closestButton =
		target instanceof HTMLElement ? target.closest<HTMLElement>('[role="button"]') : null;
	return (
		target instanceof HTMLElement &&
		(Boolean(closestButton && !closestButton.hasAttribute("data-embed-id")) ||
			Boolean(target.closest("input")) ||
			Boolean(target.closest("textarea")) ||
			Boolean(target.closest("select")) ||
			Boolean(target.closest("label")))
	);
}
