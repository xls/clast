export interface FileRow {
  file_path: string;
  hash: string;
  language: string;
  last_indexed: number;
  node_count: number;
}

export interface AstNodeRow {
  id: number;
  file_path: string;
  name: string;
  type: string;
  signature: string;
  start_line: number;
  end_line: number;
  start_col: number;
  end_col: number;
  parent_id: number | null;
  language: string;
  body_text: string;
}

export interface CallEdgeRow {
  id: number;
  caller_id: number;
  callee_id: number | null;
  callee_name: string;
  file_path: string;
  line: number;
}

export interface CommentRow {
  id: number;
  node_id: number;
  text: string;
  source: 'original' | 'generated';
  generated_at: number | null;
}

export interface StatusRow {
  files_indexed: number;
  total_nodes: number;
  total_edges: number;
  total_comments: number;
  last_indexed: number | null;
}
