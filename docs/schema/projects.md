# Projects Schema

Repository or workspace identity. One project per unique working directory.

## Canonical Format

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "project",
  "id": "-home-fox-git-myproject",     // slug-encoded path
  "displayName": "myproject",
  "path": "/home/fox/git/myproject",
  "visibility": "public|private",
  "firstSeen": "2026-01-12T00:00:00.000Z",
  "git": {
    "branch": "main",
    "remotes": [
      { "name": "origin", "url": "git@github.com:user/repo.git", "type": "push" }
    ],
    "recentCommits": [
      { "hash": "abc123", "subject": "Fix login", "author": "fox", "date": "2026-03-05" }
    ]
  }
}
```

## Slug Encoding

```
/home/fox/git/myproject     →  -home-fox-git-myproject
/home/fox/git/my.app        →  -home-fox-git-my-app
C:\Users\fox\code\app       →  C--Users-fox-code-app
```

Path separators and dots become hyphens. Leading slash becomes leading hyphen.

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Slug-encoded path (unique) |
| `displayName` | string | yes | Human-readable name |
| `path` | string | yes | Original filesystem path |
| `visibility` | string | no | `public` or `private` (for scrobble) |
| `firstSeen` | ISO 8601 | no | When project was first ingested |
| `git.branch` | string | no | Current branch |
| `git.remotes` | array | no | Git remote URLs |
| `git.recentCommits` | array | no | Recent commit history |

## Visibility

Controls whether a project appears in the public scrobble feed:

- **public**: project name, session metadata, and tool usage are scrobbled
- **private**: nothing published externally (default)

Stored in the `project_visibility` table with the project ID as primary key.

## Database Mapping

| JSON Field | DB Column | Table |
|---|---|---|
| `id` | `name` (UNIQUE) | projects |
| `displayName` | `display_name` | projects |
| `path` | `path` | projects |
| `firstSeen` | `first_seen` | projects |
| `visibility` | `visibility` | project_visibility |
