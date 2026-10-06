"""Path guards: tuning data must never sit inside a git working tree."""

from __future__ import annotations

from pathlib import Path


def inside_git_tree(path: Path) -> bool:
    """True if `path` or a parent holds `.git` (a directory, or a file in a linked worktree).

    A dotfiles repository in the home folder therefore makes every path under it refused,
    including ~/.cache/codeproctor/models: move the tuning folder or the repository.
    """
    return any((p / ".git").exists() for p in [path.resolve(), *path.resolve().parents])
