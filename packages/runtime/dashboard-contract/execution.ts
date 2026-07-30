export interface ExecutionMetrics {
  avg_files_changed: number;
  total_lines_added: number;
  total_lines_removed: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  cached_input_tokens_total: number;
  reasoning_output_tokens_total: number;
  artifact_count: number;
  session_type_distribution: Record<string, number>;
}

export interface CommitRecord {
  commit_sha: string;
  commit_title: string | null;
  branch: string | null;
  repo_remote: string | null;
  timestamp: string;
}

export interface CommitSummary {
  total_commits: number;
  unique_branches: number;
  recent_commits: Array<{
    sha: string;
    title: string;
    branch: string;
    timestamp: string;
  }>;
}
