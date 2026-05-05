export type CanvasItemState = {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
};

export type CanvasMeta = {
	version: 2;
	scopes: Record<
		string,
		{
			zoom: number;
			items: Record<string, CanvasItemState>;
		}
	>;
};

export type SectionNode = {
	id: string;
	title: string;
	level: number;
	path: string[];
	startLine: number;
	endLine: number;
	content: string;
	scopeId: string;
};

export type OrphanNode = {
	id: string;
	content: string;
	startLine: number;
	endLine: number;
	scopeId: string;
	childScopeId?: string;
};

export type ParsedScope = {
	id: string;
	title: string;
	startLine: number;
	endLine: number;
	depth: number | null;
	headingLevel: number | null;
	canvasHeadingLevel: number;
	insertLine: number;
	sections: SectionNode[];
	orphans: OrphanNode[];
};

export type ParsedDocument = {
	scopes: Record<string, ParsedScope>;
	rootScopeId: string;
	maxHeadingDepth: number;
};

export type ArkidianViewState = {
	file?: string;
	scopeId?: string;
};

export type FrontmatterTableRow = {
	key: string;
	value: string;
};

export type FrontmatterItem = {
	id: string;
	scopeId: string;
	rows: FrontmatterTableRow[];
};

export type RenderableScopeItem =
	| {
			kind: "frontmatter";
			id: string;
			startLine: number;
			item: FrontmatterItem;
	  }
	| {
			kind: "section";
			id: string;
			startLine: number;
			item: SectionNode;
	  }
	| {
			kind: "orphan";
			id: string;
			startLine: number;
			item: OrphanNode;
	  };

export type LayerTreeNode = {
	id: string;
	label: string;
	icon: string;
	kind: "frontmatter" | "section" | "orphan" | "embed";
	startLine: number;
	endLine?: number;
	sourceScopeId?: string;
	targetScopeId?: string;
	targetFilePath?: string;
	openLine?: number;
	children: LayerTreeNode[];
};

export type EmbedNode = {
	id: string;
	parentId: string;
	label: string;
	link: string;
	original: string;
	startLine: number;
	endLine: number;
	sourceScopeId: string;
	targetFilePath: string | null;
	targetScopeId: string | null;
	targetLine: number | null;
};

export type RenderableItemContext = {
	renderable: RenderableScopeItem;
	embeds: EmbedNode[];
};

export type SourceTrailEntry = {
	label: string;
	sourceFilePath: string;
	sourceScopeId: string;
	sourceLine: number;
	targetFilePath: string;
	targetScopeId: string;
};

export type ZoomPluginApi = {
	zoomIn(editor: EditorLike, line: number): void;
};

export type EditorLike = {
	setCursor(pos: { line: number; ch: number }): void;
	scrollIntoView(
		range: { from: { line: number; ch: number }; to?: { line: number; ch: number } },
		center?: boolean
	): void;
	setSelection?(
		from: { line: number; ch: number },
		to: { line: number; ch: number }
	): void;
	focus?(): void;
};
