import type TreeSitter from 'web-tree-sitter';
import type { AstNode, AstNodeType } from '../types.js';

// Node types that represent extractable symbols per language
const FUNCTION_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'method_definition',
  'method_declaration',
  'arrow_function',
  'function_item',           // Rust
  'func_declaration',        // Go
  'function_expression',
]);

const CLASS_TYPES = new Set([
  'class_declaration',
  'class_definition',
  'struct_item',             // Rust
  'struct_specifier',        // C/C++
  'impl_item',              // Rust
  'type_declaration',        // Go
]);

const INTERFACE_TYPES = new Set([
  'interface_declaration',
  'trait_item',              // Rust
]);

const IMPORT_TYPES = new Set([
  'import_statement',
  'import_declaration',
  'use_declaration',         // Rust
  'preproc_include',         // C/C++ (#include)
]);

const EXPORT_TYPES = new Set([
  'export_statement',
  'export_declaration',
]);

const ENUM_TYPES = new Set([
  'enum_declaration',
  'enum_item',               // Rust
  'enum_specifier',          // C/C++
]);

const CALL_TYPES = new Set([
  'call_expression',
  'new_expression',
  'method_invocation',       // Java
  'invocation_expression',   // C#
]);

function classifyNodeType(treeSitterType: string): AstNodeType | null {
  if (FUNCTION_TYPES.has(treeSitterType)) return 'function';
  if (CLASS_TYPES.has(treeSitterType)) return 'class';
  if (INTERFACE_TYPES.has(treeSitterType)) return 'interface';
  if (IMPORT_TYPES.has(treeSitterType)) return 'import';
  if (EXPORT_TYPES.has(treeSitterType)) return 'export';
  if (ENUM_TYPES.has(treeSitterType)) return 'enum';
  return null;
}

function extractName(node: TreeSitter.SyntaxNode): string {
  const nameNode =
    node.childForFieldName('name') ??
    node.childForFieldName('declarator')?.childForFieldName('name') ??
    node.childForFieldName('declarator');

  if (nameNode) {
    return nameNode.text;
  }

  // Arrow functions assigned to variables
  if (node.type === 'arrow_function' && node.parent) {
    const parentName = node.parent.childForFieldName('name');
    if (parentName) return parentName.text;
  }

  // Exports
  if (node.type === 'export_statement') {
    const decl = node.childForFieldName('declaration');
    if (decl) return extractName(decl);
    return '<export>';
  }

  // Imports
  if (IMPORT_TYPES.has(node.type)) {
    const source = node.childForFieldName('source') ?? node.childForFieldName('path');
    if (source) return source.text.replace(/['"]/g, '');
    return node.text.slice(0, 80);
  }

  return '<anonymous>';
}

function extractSignature(node: TreeSitter.SyntaxNode, maxLength: number = 200): string {
  const text = node.text;
  const braceIdx = text.indexOf('{');
  const parenCloseIdx = text.indexOf(')');

  let end = text.length;
  if (braceIdx > 0) {
    end = braceIdx;
  } else if (parenCloseIdx > 0) {
    end = parenCloseIdx + 1;
  }

  const sig = text.slice(0, end).trim();
  return sig.length > maxLength ? sig.slice(0, maxLength) + '...' : sig;
}

function extractPrecedingComment(
  node: TreeSitter.SyntaxNode,
  source: string
): string | null {
  const lines = source.split('\n');
  const nodeLine = node.startPosition.row;

  const commentLines: string[] = [];
  let checkLine = nodeLine - 1;

  while (checkLine >= 0) {
    const line = lines[checkLine]?.trim() ?? '';

    if (
      line.startsWith('//') ||
      line.startsWith('#') ||
      line.startsWith('*') ||
      line.startsWith('/*') ||
      line.startsWith('///') ||
      line.startsWith('/**')
    ) {
      commentLines.unshift(line);
      checkLine--;
    } else if (line === '' && commentLines.length === 0) {
      checkLine--;
    } else {
      break;
    }
  }

  if (commentLines.length === 0) return null;

  const cleaned = commentLines
    .map(l => l.replace(/^\/\/\/?\s?|^\/\*\*?\s?|^\*\/?\s?|^#\s?/g, '').trim())
    .filter(l => l.length > 0)
    .join('\n');

  return cleaned || null;
}

function extractPythonDocstring(node: TreeSitter.SyntaxNode): string | null {
  const body = node.childForFieldName('body');
  if (!body) return null;

  const firstChild = body.firstChild;
  if (!firstChild) return null;

  if (
    firstChild.type === 'expression_statement' &&
    firstChild.firstChild?.type === 'string'
  ) {
    const text = firstChild.firstChild.text;
    return text.replace(/^["']{3}|["']{3}$/g, '').trim();
  }

  return null;
}

function extractCallName(node: TreeSitter.SyntaxNode): string | null {
  const fn = node.childForFieldName('function') ?? node.childForFieldName('method');
  if (!fn) {
    const firstChild = node.firstChild;
    if (firstChild) {
      if (firstChild.type === 'member_expression' || firstChild.type === 'field_expression') {
        const prop = firstChild.childForFieldName('property') ?? firstChild.childForFieldName('field');
        return prop?.text ?? firstChild.text;
      }
      return firstChild.text;
    }
    return null;
  }

  if (fn.type === 'member_expression' || fn.type === 'field_expression') {
    const prop = fn.childForFieldName('property') ?? fn.childForFieldName('field');
    return prop?.text ?? fn.text;
  }

  return fn.text;
}

export interface ExtractionResult {
  nodes: AstNode[];
  edges: Array<{ callerNodeIndex: number; calleeName: string; line: number }>;
  comments: Array<{ nodeIndex: number; text: string; source: 'original' }>;
}

export function extractFromTree(
  tree: TreeSitter.Tree,
  filePath: string,
  language: string,
  source: string,
  maxBodySize: number = 2000
): ExtractionResult {
  const nodes: AstNode[] = [];
  const edges: Array<{ callerNodeIndex: number; calleeName: string; line: number }> = [];
  const comments: Array<{ nodeIndex: number; text: string; source: 'original' }> = [];

  const nodeIdToIndex = new Map<number, number>();

  function findEnclosingFunctionIndex(node: TreeSitter.SyntaxNode): number | null {
    let current = node.parent;
    while (current) {
      const type = classifyNodeType(current.type);
      if (type === 'function') {
        return nodeIdToIndex.get(current.id) ?? null;
      }
      current = current.parent;
    }
    return null;
  }

  function walk(node: TreeSitter.SyntaxNode, parentIndex: number | null): void {
    const nodeType = classifyNodeType(node.type);
    let currentIndex = parentIndex;

    if (nodeType && nodeType !== 'import' && nodeType !== 'export') {
      const name = extractName(node);
      const signature = extractSignature(node);
      const bodyText = node.text.length > maxBodySize
        ? node.text.slice(0, maxBodySize) + '...'
        : node.text;

      const astNode: AstNode = {
        filePath,
        name,
        type: nodeType === 'function' && parentIndex !== null ? 'method' : nodeType,
        signature,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startCol: node.startPosition.column,
        endCol: node.endPosition.column,
        parentId: null,
        language,
        bodyText,
      };

      currentIndex = nodes.length;
      nodes.push(astNode);
      nodeIdToIndex.set(node.id, currentIndex);

      const comment = language === 'python'
        ? (extractPythonDocstring(node) ?? extractPrecedingComment(node, source))
        : extractPrecedingComment(node, source);

      if (comment) {
        comments.push({ nodeIndex: currentIndex, text: comment, source: 'original' });
      }
    } else if (nodeType === 'import' || nodeType === 'export') {
      const name = extractName(node);
      nodes.push({
        filePath,
        name,
        type: nodeType,
        signature: node.text.slice(0, 200),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startCol: node.startPosition.column,
        endCol: node.endPosition.column,
        parentId: null,
        language,
        bodyText: '',
      });
    }

    // Extract call expressions
    if (CALL_TYPES.has(node.type)) {
      const calleeName = extractCallName(node);
      const enclosingFunc = findEnclosingFunctionIndex(node);
      if (calleeName && enclosingFunc !== null) {
        edges.push({
          callerNodeIndex: enclosingFunc,
          calleeName,
          line: node.startPosition.row + 1,
        });
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        walk(child, currentIndex);
      }
    }
  }

  walk(tree.rootNode, null);

  return { nodes, edges, comments };
}
