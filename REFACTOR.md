# Tourmaline Refactor Plan

## Summary

- 현재 `main.ts` 3,916줄짜리 단일 파일을 기능 경계별 `src/` 모듈로 나눈다.
- UI, 제스처, CSS 클래스, 메타 파일 형식은 보존한다.
- 먼저 깨진 `tsc --noEmit`를 복구하고, 파서/메타/문서 편집 로직에 단위 테스트를 추가한 뒤 단계적으로 분리한다.
- 코드 변경 후에는 `npm run build`와 `npm run deploy`까지 실행해 Obsidian 플러그인 배포본을 갱신한다.

## Key Changes

- 빌드 안정화:
  - `typecheck`, `test`, `verify` 스크립트를 추가하고 Vitest 기반 단위 테스트를 도입한다.
  - 현재 타입 오류 7개를 먼저 수정한다: `null`/`undefined` 불일치, breadcrumb callback narrowing, frontmatter key guard, meta legacy union narrowing, `createScopeHeadingOrphan` 인자 누락, `resolveSubpath` line access는 `result.start.line` 기준으로 수정.
- 모듈 구조:
  - 루트 `main.ts`는 플러그인 등록과 `ArkidianView` 연결만 담당한다.
  - `src/types.ts`에 공유 타입을 둔다.
  - Markdown 파싱/스코프 생성/라벨 정리는 순수 domain 모듈로 이동한다.
  - 메타 읽기/쓰기/마이그레이션은 `CanvasMetaStore`로 분리한다.
  - 섹션 저장, 새 heading 삽입, 삭제, 레이어 순서 변경은 순수 text transform + Obsidian 적용 service로 분리한다.
  - embed 해석은 `EmbedResolver`로 분리한다.
  - viewport/grid/zoom/pan은 `ViewportController`, 선택 상태는 `SelectionController`, 레이어 패널과 카드 렌더링은 view 컴포넌트로 분리한다.
- 인터페이스 보존:
  - Obsidian view state는 `{ file?: string; scopeId?: string }` 그대로 유지한다.
  - `<filename>.meta.json`의 `version: 2`, `scopes`, `items`, `zoom` 구조는 유지한다.
  - 기존 CSS 클래스와 사용자 제스처는 유지한다.
  - 내부 ID는 중복 heading 충돌을 막도록 heading path + sibling occurrence 기반으로 안정화하되, 기존 meta key를 fallback으로 읽어 레이아웃 손실을 막는다.

## Test Plan

- 단위 테스트:
  - frontmatter 제외와 line offset 보존.
  - 최상위 heading 기준 shell 분리.
  - shell-less 블록의 child scope 생성.
  - duplicate heading ID 충돌 방지.
  - legacy flat meta와 v2 scoped meta 읽기.
  - delete/create/move source transform 결과.
  - embed subpath line 해석.
- 검증 명령:
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `npm run deploy`
- 수동 확인:
  - Obsidian에서 현재 Markdown을 Tourmaline으로 열기.
  - zoom/pan/fit, 카드 drag/resize persistence.
  - layer 선택, expand/collapse, reorder.
  - Ctrl/Cmd-click drill-down, double-click source popout.
  - embed 선택/진입/소스 열기.
  - frontmatter edit/delete.
  - Delete/Backspace source block 삭제.
  - 외부 Markdown 수정 후 canvas refresh.

## Assumptions

- 리팩터링은 점진적으로 진행하며, 사용자 체감 UI와 동작은 바꾸지 않는다.
- 새 테스트 프레임워크는 Vitest를 사용한다.
- `REQUIREMENT.md`는 제품 요구사항 변경이 없으므로 이번 계획만으로는 수정하지 않는다.
