"""Path guards: tuning data must never sit inside a git working tree."""

from __future__ import annotations

from pathlib import Path


def inside_git_tree(path: Path) -> bool:
    """True if `path` or a parent holds `.git` (a directory, or a file in a linked worktree).

    A dotfiles repository in the home folder therefore makes every path under it refused,
    including ~/.cache/codeproctor/models: move the tuning folder or the repository.
    """
    return any((p / ".git").exists() for p in [path.resolve(), *path.resolve().parents])


def model_path_allowed(raw: str, models_dir: Path) -> bool:
    """C-22: a model file may be used only from the models folder, never from a git tree.

    The folder itself must not be a symlink, and the resolved target (symlinks and `..` followed)
    must sit inside the resolved folder.
    """
    if not raw or models_dir.is_symlink():
        return False
    target = Path(raw).expanduser().resolve()
    return target.is_relative_to(models_dir.resolve()) and not inside_git_tree(target)
