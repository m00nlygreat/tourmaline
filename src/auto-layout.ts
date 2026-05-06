import { layout, prepare } from "@chenglou/pretext";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { toString } from "mdast-util-to-string";
import type { Root } from "mdast";
import {
	DEFAULT_CARD_HEIGHT,
	DEFAULT_CARD_WIDTH
} from "./constants";
import type {
	CanvasItemState,
	RenderableItemContext,
	RenderableScopeItem
} from "./types";

const SECTION_GAP_X = 80;
const SECTION_GAP_Y = 56;
const SECTION_COLUMNS = 3;
const SECTION_START_Y = -300;
const SUPPORT_X = -760;
const SUPPORT_START_Y = -300;
const SUPPORT_GAP_Y = 42;
const CARD_HORIZONTAL_CHROME = 32;
const CARD_VERTICAL_CHROME = 84;
const BODY_FONT = "14px Arial";
const BODY_LINE_HEIGHT = 22;

type LayoutInput = {
	contexts: RenderableItemContext[];
	existingItems: Record<string, CanvasItemState>;
};

export function createPredictedItemStates({
	contexts,
	existingItems
}: LayoutInput): Record<string, CanvasItemState> {
	const nextItems: Record<string, CanvasItemState> = {};
	const sectionColumnHeights = Array.from({ length: SECTION_COLUMNS }, () => 0);
	let supportY = SUPPORT_START_Y;

	for (const context of contexts) {
		const { renderable } = context;
		const existing = existingItems[renderable.id];
		if (existing) {
			nextItems[renderable.id] = existing;
			if (renderable.kind === "section") {
				const column = getNearestSectionColumn(existing.x);
				sectionColumnHeights[column] = Math.max(
					sectionColumnHeights[column],
					existing.y - SECTION_START_Y + existing.height + SECTION_GAP_Y
				);
			} else {
				supportY = Math.max(supportY, existing.y + existing.height + SUPPORT_GAP_Y);
			}
			continue;
		}

		const predictedHeight = predictItemHeight(renderable, context.embeds.length);
		if (renderable.kind === "frontmatter" || renderable.kind === "orphan") {
			nextItems[renderable.id] = {
				id: renderable.id,
				x: SUPPORT_X,
				y: supportY,
				width: renderable.kind === "frontmatter" ? 520 : DEFAULT_CARD_WIDTH,
				height: predictedHeight
			};
			supportY += predictedHeight + SUPPORT_GAP_Y;
			continue;
		}

		const column = getShortestColumnIndex(sectionColumnHeights);
		const x = getSectionColumnX(column);
		const y = SECTION_START_Y + sectionColumnHeights[column];
		nextItems[renderable.id] = {
			id: renderable.id,
			x,
			y,
			width: DEFAULT_CARD_WIDTH,
			height: predictedHeight
		};
		sectionColumnHeights[column] += predictedHeight + SECTION_GAP_Y;
	}

	return nextItems;
}

function predictItemHeight(renderable: RenderableScopeItem, embedCount: number) {
	if (renderable.kind === "frontmatter") {
		return Math.max(180, 92 + renderable.item.rows.length * 30);
	}

	if (renderable.kind === "orphan") {
		const textHeight = predictMarkdownTextHeight(renderable.item.content, DEFAULT_CARD_WIDTH);
		return Math.max(48, textHeight + 16);
	}

	const textHeight = predictMarkdownTextHeight(renderable.item.content, DEFAULT_CARD_WIDTH);
	const embedAllowance = embedCount * 96;
	return Math.max(DEFAULT_CARD_HEIGHT, textHeight + CARD_VERTICAL_CHROME + embedAllowance);
}

function predictMarkdownTextHeight(markdown: string, itemWidth: number) {
	const text = getMarkdownPlainText(markdown);
	if (!text.trim()) {
		return BODY_LINE_HEIGHT;
	}

	const prepared = prepare(text, BODY_FONT, { whiteSpace: "pre-wrap" });
	const { height } = layout(
		prepared,
		Math.max(1, itemWidth - CARD_HORIZONTAL_CHROME),
		BODY_LINE_HEIGHT
	);
	return height;
}

function getMarkdownPlainText(markdown: string) {
	try {
		const tree = unified().use(remarkParse).parse(markdown) as Root;
		return toString(tree);
	} catch {
		return markdown;
	}
}

function getShortestColumnIndex(columnHeights: number[]) {
	return columnHeights.reduce(
		(shortestIndex, height, index) =>
			height < columnHeights[shortestIndex] ? index : shortestIndex,
		0
	);
}

function getSectionColumnX(column: number) {
	const step = DEFAULT_CARD_WIDTH + SECTION_GAP_X;
	return (column - (SECTION_COLUMNS - 1) / 2) * step;
}

function getNearestSectionColumn(x: number) {
	let nearestColumn = 0;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (let column = 0; column < SECTION_COLUMNS; column += 1) {
		const distance = Math.abs(x - getSectionColumnX(column));
		if (distance < nearestDistance) {
			nearestColumn = column;
			nearestDistance = distance;
		}
	}
	return nearestColumn;
}
