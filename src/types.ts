export type AstNodeType =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'enum'
  | 'import'
  | 'export'
  | 'variable'
  | 'type_alias'
  | 'struct'
  | 'trait'
  | 'module';

export interface AstNode {
  id?: number;
  filePath: string;
  name: string;
  type: AstNodeType;
  signature: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  parentId: number | null;
  language: string;
  bodyText: string;
}

export interface CallEdge {
  id?: number;
  callerId: number;
  calleeId: number | null;
  calleeName: string;
  filePath: string;
  line: number;
}

export interface FileInfo {
  filePath: string;
  hash: string;
  language: string;
  lastIndexed: number;
  nodeCount: number;
}

export interface CommentInfo {
  id?: number;
  nodeId: number;
  text: string;
  source: 'original' | 'generated';
  generatedAt: number | null;
}

export interface ParseResult {
  nodes: AstNode[];
  edges: CallEdge[];
  comments: CommentInfo[];
}

export interface IndexStatus {
  filesIndexed: number;
  totalNodes: number;
  totalEdges: number;
  totalComments: number;
  lastIndexed: number | null;
  watcherActive: boolean;
  pendingFiles: number;
}
