// 项目工作区文件编辑器运行时：基于 CodeMirror 6 的多语言编辑与行级 Diff 视图。
// 由聊天项目工作区按需懒加载，编辑器代码不进入聊天主包。

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  selectAll as selectAllCommand,
} from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  tooltips,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

import { baseTheme, fontSizeTheme, readOnlyExtension } from "@/shared/components/json-code-editor-runtime";

export type ProjectCodeEditorTheme = "light" | "dark";

export type DiffLineKind = "context" | "add" | "remove";

export type ProjectCodeEditorOptions = {
  parent: HTMLElement;
  path: string;
  value: string;
  // 传入原始内容即进入只读 Diff 视图（合并为一列行号的单编辑器）。
  original?: string;
  readOnly: boolean;
  wordWrap: boolean;
  theme: ProjectCodeEditorTheme;
  fontSize: number;
  onChange: (value: string) => void;
};

export type ProjectCodeEditorController = {
  getValue: () => string;
  // 替换文档内容但不通过 onChange 上报（程序化更新）。
  setValue: (value: string) => void;
  setTheme: (theme: ProjectCodeEditorTheme) => void;
  setWordWrap: (wordWrap: boolean) => void;
  setFontSize: (fontSize: number) => void;
  focus: () => void;
  destroy: () => void;
  selectAll: () => void;
  find: () => void;
  copy: () => Promise<void>;
  cut: () => Promise<void>;
  paste: () => Promise<void>;
};

const INDENT = "  ";

// 标记程序化文档替换，避免被回显为用户编辑。
const externalChange = Annotation.define<boolean>();

type EditorPalette = {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  variable: string;
  type: string;
  property: string;
  punctuation: string;
  invalid: string;
  activeLine: string;
  selection: string;
  subtleHighlight: string;
  searchMatch: string;
  diffAdd: string;
  diffRemove: string;
};

// 多语言高亮配色与 JSON 编辑器保持一致的中性暖色面：数值满足 WCAG AA，注释与标点退后。
const LIGHT_PALETTE: EditorPalette = {
  keyword: "#9b3f6b",
  string: "#467330",
  number: "#b4532a",
  comment: "#8a857b",
  variable: "#3f5f7f",
  type: "#2b5f8f",
  property: "#2b5f8f",
  punctuation: "#8a857b",
  invalid: "#d0382b",
  activeLine: "rgba(0, 0, 0, 0.03)",
  selection: "rgba(59, 130, 246, 0.16)",
  subtleHighlight: "rgba(0, 0, 0, 0.07)",
  searchMatch: "rgba(234, 179, 8, 0.28)",
  diffAdd: "rgba(46, 160, 67, 0.16)",
  diffRemove: "rgba(248, 113, 113, 0.14)",
};

const DARK_PALETTE: EditorPalette = {
  keyword: "#e08bb0",
  string: "#a9cb8d",
  number: "#e9a07c",
  comment: "#7f7a71",
  variable: "#9fb8d0",
  type: "#8db9e4",
  property: "#8db9e4",
  punctuation: "#7f7a71",
  invalid: "#f07468",
  activeLine: "rgba(255, 255, 255, 0.035)",
  selection: "rgba(96, 165, 250, 0.24)",
  subtleHighlight: "rgba(255, 255, 255, 0.1)",
  searchMatch: "rgba(234, 179, 8, 0.24)",
  diffAdd: "rgba(46, 160, 67, 0.2)",
  diffRemove: "rgba(248, 113, 113, 0.18)",
};

function highlightStyleFor(palette: EditorPalette): HighlightStyle {
  return HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword], color: palette.keyword },
    { tag: [tags.string, tags.special(tags.string)], color: palette.string },
    { tag: [tags.number, tags.bool, tags.null], color: palette.number },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: palette.comment, fontStyle: "italic" },
    { tag: [tags.variableName, tags.definition(tags.variableName)], color: palette.variable },
    { tag: [tags.typeName, tags.className, tags.namespace], color: palette.type },
    { tag: [tags.propertyName, tags.attributeName], color: palette.property },
    { tag: [tags.tagName, tags.angleBracket], color: palette.keyword },
    { tag: [tags.punctuation, tags.separator, tags.bracket, tags.operator], color: palette.punctuation },
    { tag: tags.invalid, color: palette.invalid },
  ]);
}

const lightHighlightStyle = highlightStyleFor(LIGHT_PALETTE);
const darkHighlightStyle = highlightStyleFor(DARK_PALETTE);

// Diff 行的整行底色由 CSS 类承载，避免运行时注入额外 style 标签。
const diffLineDecorations = new Map<DiffLineKind, Decoration>();
function diffLineDecoration(kind: Exclude<DiffLineKind, "context">): Decoration {
  let decoration = diffLineDecorations.get(kind);
  if (!decoration) {
    decoration = Decoration.line({ class: kind === "add" ? "deeix-diff-add" : "deeix-diff-remove" });
    diffLineDecorations.set(kind, decoration);
  }
  return decoration;
}

type DiffPayload = { lines: string[]; kinds: DiffLineKind[] };

const setDiffLines = StateEffect.define<DiffPayload>();

function buildDiffDecorations(payload: DiffPayload): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  let position = 0;
  for (let index = 0; index < payload.kinds.length; index += 1) {
    const kind = payload.kinds[index];
    if (kind !== "context") {
      ranges.push(diffLineDecoration(kind).range(position));
    }
    position += (payload.lines[index] ?? "").length + 1;
  }
  return Decoration.set(ranges, true);
}

function diffDecorationsField(payload: DiffPayload): Extension {
  return StateField.define<DecorationSet>({
    create: () => buildDiffDecorations(payload),
    update: (value, transaction) => {
      for (const effect of transaction.effects) {
        if (effect.is(setDiffLines)) {
          return buildDiffDecorations(effect.value);
        }
      }
      return value.map(transaction.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

function chromeTheme(theme: ProjectCodeEditorTheme): Extension {
  const dark = theme === "dark";
  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE;
  return [
    EditorView.theme(
      {
        // 空闲时按普通文档呈现，聚焦后才显示当前行与选区。
        ".cm-activeLine": { backgroundColor: "transparent" },
        "&.cm-focused .cm-activeLine": { backgroundColor: palette.activeLine },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
          { backgroundColor: palette.selection },
        "&.cm-focused .cm-matchingBracket": {
          backgroundColor: palette.subtleHighlight,
          borderRadius: "2px",
          outline: "none",
        },
        "&.cm-focused .cm-nonmatchingBracket": { color: palette.invalid },
        ".cm-selectionMatch": { backgroundColor: palette.subtleHighlight },
        ".cm-searchMatch": { backgroundColor: palette.searchMatch, outline: "none" },
        ".deeix-diff-add": { backgroundColor: palette.diffAdd },
        ".deeix-diff-remove": {
          backgroundColor: palette.diffRemove,
          textDecoration: "line-through",
          textDecorationColor: "rgba(248, 113, 113, 0.6)",
        },
      },
      { dark },
    ),
    syntaxHighlighting(dark ? darkHighlightStyle : lightHighlightStyle),
  ];
}

// 按文件扩展名选择语言扩展；未识别类型保持纯文本。
function languageFor(path: string): Extension {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  switch (extension) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: true });
    case "ts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "json":
      return json();
    case "css":
    case "scss":
    case "less":
      return css();
    case "html":
    case "htm":
    case "vue":
    case "xml":
    case "svg":
      return html();
    case "md":
    case "markdown":
      return markdown();
    case "py":
      return python();
    default:
      return [];
  }
}

// 合并旧新内容为单编辑器视图，保证只有一列行号。
export function computeLineDiff(oldText: string, newText: string): DiffPayload {
  const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
  const newLines = newText.length === 0 ? [] : newText.split("\n");
  // 超大文本退化为"整段删除 + 整段新增"，避免 O(n*m) 的 DP 表。
  if (oldLines.length * newLines.length > 4_000_000) {
    return {
      lines: [...oldLines, ...newLines],
      kinds: [...oldLines.map(() => "remove" as const), ...newLines.map(() => "add" as const)],
    };
  }
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: string[] = [];
  const kinds: DiffLineKind[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      lines.push(oldLines[i]);
      kinds.push("context");
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(oldLines[i]);
      kinds.push("remove");
      i += 1;
    } else {
      lines.push(newLines[j]);
      kinds.push("add");
      j += 1;
    }
  }
  while (i < rows) {
    lines.push(oldLines[i]);
    kinds.push("remove");
    i += 1;
  }
  while (j < cols) {
    lines.push(newLines[j]);
    kinds.push("add");
    j += 1;
  }
  return { lines, kinds };
}

function selectedText(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return view.state.sliceDoc(from, to);
}

export function createProjectCodeEditor(options: ProjectCodeEditorOptions): ProjectCodeEditorController {
  const themeCompartment = new Compartment();
  const wordWrapCompartment = new Compartment();
  const fontSizeCompartment = new Compartment();
  const isDiff = options.original !== undefined;
  const merged = isDiff ? computeLineDiff(options.original ?? "", options.value) : null;

  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: merged ? merged.lines.join("\n") : options.value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        EditorState.tabSize.of(INDENT.length),
        indentUnit.of(INDENT),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        languageFor(options.path),
        merged ? diffDecorationsField(merged) : [],
        readOnlyExtension(options.readOnly || isDiff),
        wordWrapCompartment.of(options.wordWrap ? EditorView.lineWrapping : []),
        themeCompartment.of(chromeTheme(options.theme)),
        fontSizeCompartment.of(fontSizeTheme(options.fontSize)),
        // 提示与搜索面板挂到 body，避免被工作区面板的裁剪或变换裁掉。
        tooltips({ parent: document.body }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        baseTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalChange))) {
            options.onChange(update.state.doc.toString());
          }
        }),
      ],
    }),
  });

  return {
    getValue: () => view.state.doc.toString(),
    setValue: (value) => {
      if (isDiff) {
        const next = computeLineDiff(options.original ?? "", value);
        const merged = next.lines.join("\n");
        if (merged === view.state.doc.toString()) {
          return;
        }
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: merged },
          effects: setDiffLines.of(next),
          annotations: externalChange.of(true),
        });
        return;
      }
      if (value === view.state.doc.toString()) {
        return;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: externalChange.of(true),
      });
    },
    setTheme: (theme) => {
      view.dispatch({ effects: themeCompartment.reconfigure(chromeTheme(theme)) });
    },
    setWordWrap: (wordWrap) => {
      view.dispatch({ effects: wordWrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : []) });
    },
    setFontSize: (fontSize) => {
      view.dispatch({ effects: fontSizeCompartment.reconfigure(fontSizeTheme(fontSize)) });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
    selectAll: () => {
      view.focus();
      selectAllCommand(view);
    },
    find: () => {
      view.focus();
      openSearchPanel(view);
    },
    copy: async () => {
      view.focus();
      await navigator.clipboard.writeText(selectedText(view));
    },
    cut: async () => {
      view.focus();
      if (view.state.readOnly) {
        return;
      }
      await navigator.clipboard.writeText(selectedText(view));
      view.dispatch(view.state.replaceSelection(""));
    },
    paste: async () => {
      view.focus();
      if (view.state.readOnly) {
        return;
      }
      const text = await navigator.clipboard.readText();
      view.dispatch(view.state.replaceSelection(text));
    },
  };
}
