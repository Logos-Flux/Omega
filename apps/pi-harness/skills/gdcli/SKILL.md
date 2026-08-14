---
name: gdcli
description: "Google Drive CLI for the user's OWN My Drive only. CANNOT see Shared Drives or the knowledge base — for any KB / Shared-Drive file (reading full content, copying, commenting) use the drive_search / drive_fetch_file / drive_copy_file / drive_comment TOOLS instead, not this skill."
---

# Google Drive CLI

Command-line interface for the user's personal **My Drive** only.

> ⚠️ **gdcli cannot see Shared Drives** (it omits `supportsAllDrives`). The
> knowledge base lives in a Shared Drive, so gdcli will NOT find KB files. To
> read the full content of a KB/Shared-Drive file, copy it, or comment on it,
> use the built-in **`drive_search` / `drive_fetch_file` / `drive_copy_file` /
> `drive_comment` tools** — they are Shared-Drive aware. Use gdcli only for
> files in the user's own My Drive.

## Installation

```bash
npm install -g @mariozechner/gdcli
```

## Setup

### Google Cloud Console (one-time)

1. [Create a new project](https://console.cloud.google.com/projectcreate) (or select existing)
2. [Enable the Google Drive API](https://console.cloud.google.com/apis/api/drive.googleapis.com)
3. [Set app name](https://console.cloud.google.com/auth/branding) in OAuth branding
4. [Add test users](https://console.cloud.google.com/auth/audience) (all Gmail addresses you want to use)
5. [Create OAuth client](https://console.cloud.google.com/auth/clients):
   - Click "Create Client"
   - Application type: "Desktop app"
   - Download the JSON file

### Configure gdcli

First check if already configured:
```bash
gdcli accounts list
```

If no accounts, guide the user through setup:
1. Ask if they have a Google Cloud project with Drive API enabled
2. If not, walk them through the Google Cloud Console steps above
3. Have them download the OAuth credentials JSON
4. Run: `gdcli accounts credentials ~/path/to/credentials.json`
5. Run: `gdcli accounts add <email>` (use `--manual` for browserless OAuth)

## Usage

Run `gdcli --help` for full command reference.

Common operations:
- `gdcli <email> ls [folderId]` - List files/folders
- `gdcli <email> ls --query "<query>"` - List with Drive query filter
- `gdcli <email> search "<text>"` - Full-text content search
- `gdcli <email> download <fileId> [destPath]` - Download a file
- `gdcli <email> upload <localPath> [--folder <folderId>]` - Upload a file
- `gdcli <email> mkdir <name>` - Create a folder
- `gdcli <email> share <fileId> --anyone` - Share publicly

## Search

**Two different commands:**
- `search "<text>"` - Searches inside file contents (fullText)
- `ls --query "<query>"` - Filters by metadata (name, type, date, etc.)

**Use `ls --query` for filename searches!**

## Query Syntax (for ls --query)

Format: `field operator value`. Combine with `and`/`or`, group with `()`.

**Operators:** `=`, `!=`, `contains`, `<`, `>`, `<=`, `>=`

**Examples:**
```bash
# By filename
ls --query "name = 'report.pdf'"           # exact match
ls --query "name contains 'IMG'"           # prefix match

# By type
ls --query "mimeType = 'application/pdf'"
ls --query "mimeType contains 'image/'"
ls --query "mimeType = 'application/vnd.google-apps.folder'"  # folders

# By date
ls --query "modifiedTime > '2024-01-01'"

# By owner/sharing
ls --query "'me' in owners"
ls --query "sharedWithMe"

# Exclude trash
ls --query "trashed = false"

# Combined
ls --query "name contains 'report' and mimeType = 'application/pdf'"
```

Ref: https://developers.google.com/drive/api/guides/ref-search-terms

## Data Storage

- `~/.gdcli/credentials.json` - OAuth client credentials
- `~/.gdcli/accounts.json` - Account tokens
- `~/.gdcli/downloads/` - Default download location
