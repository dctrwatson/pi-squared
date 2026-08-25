export type Placement = "primary" | "managed";

export interface PullRequest {
    number: number;
    url: string;
    baseRepository: string;
    headRepository: string;
    headRef: string;
    headOid?: string;
}

export interface WorkspaceRecord {
    version: 2;
    repository: string;
    branch: string;
    session: string;
    cwd: string;
    pr?: PullRequest;
    prUrl?: string;
    updatedAt: string;
}

export interface WorkspaceMetadata {
    repository: string;
    branch: string;
    cwd: string;
    pr?: PullRequest;
}

export interface LeaseRecord {
    version: 1;
    repository: string;
    branch: string;
    session: string;
    pid: number;
    hostname: string;
    startedAt: string;
    updatedAt: string;
}

export type WorkspaceTarget =
    | { type: "branch"; branch: string }
    | { type: "pr"; number: number; url?: string };

export interface PullRequestDetails extends PullRequest {
    branch: string;
}

export interface Worktree {
    cwd: string;
    branch?: string;
    detached: boolean;
}

export interface WorkspaceStatus {
    record: WorkspaceRecord;
    placement: Placement;
    recency: number | undefined;
    dirty: boolean;
    stale: boolean;
    active: boolean;
    activeLease?: LeaseRecord;
}

export interface Activation {
    record: WorkspaceRecord;
    createdSession: boolean;
    createdWorktree?: string;
    previousPrimaryBranch?: string;
}

export interface PruneResult {
    pruned: string[];
    skipped: Array<{ branch: string; reason: string }>;
}

export interface PullRequestDivergence {
    branch: string;
    number: number;
    url: string;
    localOid: string;
    remoteOid: string;
    canFastForward: boolean;
}

export type PullRequestDivergenceChoice = "keep-local" | "fast-forward" | "reset" | "cancel";

export interface NewWorkspaceOptions {
    branch: string;
    from?: string;
    parallel: boolean;
}
