# GitHub Todo Extension

Manage GitHub issues labeled with `pi-todo` as a todo list. The extension provides both an LLM tool and interactive user commands.

## Structure

```
gh-todo/
├── index.ts      # Main entry point - registers tool, commands, and events
├── types.ts      # Type definitions and constants
├── utils.ts      # Utility functions for parsing and session names
├── github.ts     # GitHub CLI operations (list, create, update issues)
├── pr.ts         # PR creation and template handling
├── ui.ts         # TodoListComponent for interactive /todo UI
├── tool.ts       # gh_todo tool for LLM
└── commands.ts   # /todo and /todo-pr command handlers
```

## Files

### index.ts (41 lines)
Main entry point that:
- Creates the cached issues store
- Registers the `gh_todo` tool
- Registers the `/todo` and `/todo-pr` commands
- Sets up session start event handler

### types.ts (~85 lines)
Type definitions:
- `GhIssue` - GitHub issue structure
- `PrReviewComment` - PR review comment structure
- `PrComment` - PR conversation comment structure
- `GhTodoDetails` - Tool result details
- `GhTodoParams` - Tool parameters schema
- Constants: `PI_TODO_LABEL`, section markers, PR template locations

### utils.ts (169 lines)
Helper functions:
- Section wrapping/extraction (`wrapInCollapsible`, `extractPiSection`, `updatePiSection`)
- Session naming (`getIssueSessionName`, `sessionMatchesIssue`)
- Issue parsing (`parseIssues`, `parseIssue`)
- Branch/session utilities (`extractIssueNumberFromSession`, `extractIssueNumberFromBranch`)

### github.ts (~280 lines)
GitHub CLI operations:
- Issue CRUD: `listIssues`, `createIssue`, `getIssue`, `updateIssueNotes`
- Issue actions: `closeIssue`, `reopenIssue`, `addIssueComment`
- Git operations: `getCurrentBranch`, `hasUncommittedChanges`, `pushBranch`
- PR operations: `getPrForBranch`, `getPrFeedback` (review & conversation comments)
- Utilities: `checkGhCli`, `ensureLabel`, `openInBrowser`

### pr.ts (227 lines)
PR-related functionality:
- `findPrTemplate` - Locate PR template in repo
- `gatherSessionContext` - Extract session history for AI
- `generatePrSummary` - Generate PR description using Haiku
- `fillPrTemplate` - Fill template with issue link and summary
- `createPr` - Create PR via GitHub CLI

### ui.ts (476 lines)
Interactive UI component:
- `TodoListComponent` class - Full-screen interactive todo list
- Modes: list, add, detail
- Actions: navigate, add, start, close, reopen, plan, comment, refresh
- Keyboard shortcuts: hjk/arrows, a/s/x/r/p/m/g/o/q

### tool.ts (~600 lines)
LLM tool registration:
- Tool definition: `gh_todo`
- Actions: list, add, view, plan, start, close, reopen, update, pr, feedback
- Execute handler - implements all actions
- Render methods - format tool calls and results for TUI

### commands.ts (548 lines)
User command handlers:
- `/todo` - Interactive todo manager with TodoListComponent
- `/todo-pr` - Create PR for current issue with AI-generated description
- Post-UI handlers for starting sessions and adding comments

## Usage

### For Users
```bash
/todo       # Open interactive todo manager
/todo-pr    # Create PR for current issue
```

### For LLM
The `gh_todo` tool supports these actions:
- `list` - List all todos
- `add` - Create new issue
- `view` - View issue details
- `plan` - Start planning (ask questions)
- `update` - Update Pi Agent Notes
- `start` - Check/create session for issue
- `close` - Close issue (not planned)
- `reopen` - Reopen closed issue
- `pr` - Create PR for issue
- `feedback` - Fetch PR review comments and conversation comments (auto-detects PR from current branch)
- `pr-update` - Push changes (if any) and post auto-generated summary comment to PR after addressing feedback. Scopes context to entries since last `pr` or `pr-update` checkpoint.

## Development

Each file is focused on a single concern:
- **Types** - Shared type definitions
- **Utils** - Pure utility functions
- **GitHub** - External GitHub API interactions
- **PR** - PR-specific logic and AI integration
- **UI** - Interactive user interface
- **Tool** - LLM tool implementation
- **Commands** - User command implementations
- **Index** - Extension registration and wiring

This structure makes it easy to:
- Find and modify specific functionality
- Test individual components
- Understand the codebase
- Add new features
