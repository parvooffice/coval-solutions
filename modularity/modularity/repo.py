"""Repository acquisition: parse specs, clone into a temp dir, always clean up."""

from __future__ import annotations

import atexit
import logging
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import Optional

log = logging.getLogger(__name__)


class RepoError(Exception):
    """Base class for problems acquiring the repository."""


class InvalidRepoSpec(RepoError):
    """The user-supplied repository argument could not be understood."""


class CloneError(RepoError):
    """``git clone`` failed or timed out."""


_OWNER = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})"
_REPO = r"[A-Za-z0-9_.\-]{1,100}"
_GITHUB_PATTERNS = [
    re.compile(
        rf"^(?:https?://)?(?:www\.)?github\.com/(?P<owner>{_OWNER})/(?P<repo>{_REPO})(?:[/?#].*)?$",
        re.IGNORECASE,
    ),
    re.compile(
        rf"^(?:ssh://)?git@github\.com[:/](?P<owner>{_OWNER})/(?P<repo>{_REPO})(?:[/?#].*)?$",
        re.IGNORECASE,
    ),
    re.compile(rf"^(?P<owner>{_OWNER})/(?P<repo>{_REPO})$"),
]


@dataclass(frozen=True)
class GitHubRepo:
    owner: str
    name: str

    @property
    def clone_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.name}.git"

    @property
    def web_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.name}"


def parse_github_spec(spec: str) -> Optional[GitHubRepo]:
    """Return the GitHub repo described by *spec*, or None if it is not one."""
    spec = spec.strip()
    for pattern in _GITHUB_PATTERNS:
        m = pattern.match(spec)
        if not m:
            continue
        repo = m.group("repo")
        if repo.lower().endswith(".git"):
            repo = repo[:-4]
        if not repo or repo in {".", ".."} or repo.startswith("-"):
            return None
        return GitHubRepo(m.group("owner"), repo)
    return None


@dataclass
class RepoInfo:
    """Where the code lives and where it came from."""

    root: str
    source: str  # "clone" | "local"
    input_spec: str
    url: Optional[str] = None
    commit: Optional[str] = None
    branch: Optional[str] = None


# --------------------------------------------------------------------------
# Deletion
# --------------------------------------------------------------------------

def _make_writable(path: str) -> None:
    try:
        os.chmod(path, stat.S_IRWXU)
    except OSError:
        pass


def _retry_remove(func, path: str, *_exc) -> None:
    """rmtree error hook: clear read-only bits (git packs, Windows) and retry."""
    _make_writable(os.path.dirname(path) or ".")
    _make_writable(path)
    try:
        func(path)
    except FileNotFoundError:
        pass
    except OSError as exc:
        log.debug("could not remove %s: %s", path, exc)


def _chmod_tree(path: str) -> None:
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        _make_writable(dirpath)
        for name in filenames:
            _make_writable(os.path.join(dirpath, name))


def secure_rmtree(path: str, attempts: int = 3) -> bool:
    """Remove *path* recursively, retrying through permission problems.

    Never follows symlinks. Returns True only if nothing is left behind.
    """
    for attempt in range(attempts):
        if not os.path.lexists(path):
            return True
        try:
            if sys.version_info >= (3, 12):
                shutil.rmtree(path, onexc=_retry_remove)
            else:
                shutil.rmtree(path, onerror=_retry_remove)
        except OSError as exc:
            log.debug("rmtree attempt %d failed for %s: %s", attempt + 1, path, exc)
        if not os.path.lexists(path):
            return True
        _chmod_tree(path)
        time.sleep(0.2 * (attempt + 1))
    return not os.path.lexists(path)


# --------------------------------------------------------------------------
# git helpers
# --------------------------------------------------------------------------

def _git_env() -> dict:
    env = dict(os.environ)
    env.update(
        {
            "GIT_TERMINAL_PROMPT": "0",  # never block on credential prompts
            "GCM_INTERACTIVE": "never",
            "GIT_LFS_SKIP_SMUDGE": "1",  # do not download LFS payloads
            "LC_ALL": "C",
        }
    )
    return env


def _run_git(args: list, cwd: Optional[str] = None, timeout: float = 15.0) -> Optional[str]:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd,
            env=_git_env(),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def _mask_credentials(url: Optional[str]) -> Optional[str]:
    if not url:
        return url
    return re.sub(r"//[^/@\s]+@", "//", url)


def _describe_checkout(root: str) -> tuple:
    commit = _run_git(["rev-parse", "HEAD"], cwd=root)
    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=root)
    if branch == "HEAD":
        branch = None  # detached
    remote = _run_git(["config", "--get", "remote.origin.url"], cwd=root)
    return commit, branch, _mask_credentials(remote)


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        if hasattr(os, "killpg"):
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        else:
            proc.kill()
    except (OSError, ProcessLookupError):
        pass


def _clone(url: str, dest: str, branch: Optional[str], timeout: float) -> None:
    if url.startswith("-"):
        raise InvalidRepoSpec("refusing a repository URL that starts with '-'")
    cmd = [
        "git",
        "-c", "core.symlinks=false",
        "-c", "core.fsmonitor=false",
        "-c", "advice.detachedHead=false",
        "clone",
        "--depth", "1",
        "--single-branch",
        "--no-tags",
        "--quiet",
    ]
    if branch:
        if branch.startswith("-"):
            raise InvalidRepoSpec("branch name must not start with '-'")
        cmd += ["--branch", branch]
    cmd += ["--", url, dest]

    popen_kwargs = {}
    if hasattr(os, "setsid"):
        popen_kwargs["start_new_session"] = True  # lets us kill git's helpers too
    try:
        proc = subprocess.Popen(
            cmd,
            env=_git_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            **popen_kwargs,
        )
    except OSError as exc:
        raise CloneError(f"could not run git: {exc}") from exc

    try:
        _out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        proc.communicate()
        raise CloneError(f"git clone timed out after {timeout:.0f}s") from None
    except BaseException:
        _kill_group(proc)
        raise

    if proc.returncode != 0:
        err = (err or "").strip()
        low = err.lower()
        if "not found" in low or "could not read username" in low or "authentication failed" in low:
            raise CloneError(
                "repository not found, or it is private (only public repositories are supported)"
            )
        if "remote branch" in low and "not found" in low:
            raise CloneError(f"branch {branch!r} does not exist in the repository")
        if "could not resolve host" in low or "unable to access" in low:
            raise CloneError(f"network error while cloning: {err.splitlines()[-1] if err else 'unknown'}")
        raise CloneError(f"git clone failed: {err.splitlines()[-1] if err else 'unknown error'}")


# --------------------------------------------------------------------------
# Workspace
# --------------------------------------------------------------------------

class RepoWorkspace:
    """Context manager that yields a :class:`RepoInfo` and guarantees cleanup.

    * Local directories are used in place and never modified or deleted.
    * Remote repos are shallow-cloned into ``tempfile.mkdtemp`` and the whole
      temp directory is removed on exit, on exceptions, on Ctrl+C, on SIGTERM
      and (as a last resort) via ``atexit``.
    """

    def __init__(
        self,
        spec: str,
        branch: Optional[str] = None,
        clone_timeout: float = 900.0,
        clone_url_override: Optional[str] = None,  # used by tests (local bare repos)
    ) -> None:
        self.spec = spec
        self.branch = branch
        self.clone_timeout = clone_timeout
        self._clone_url_override = clone_url_override
        self._tmp_dir: Optional[str] = None
        self._old_handlers: dict = {}
        self.used_temp_clone = False
        self.cleanup_ok = True
        self.leftover_path: Optional[str] = None

    # -- context manager ---------------------------------------------------
    def __enter__(self) -> RepoInfo:
        local = os.path.expanduser(self.spec)
        if os.path.isdir(local):
            root = os.path.abspath(local)
            commit, branch, remote = _describe_checkout(root)
            return RepoInfo(root, "local", self.spec, url=remote, commit=commit, branch=branch)

        repo = None if self._clone_url_override else parse_github_spec(self.spec)
        if repo is None and not self._clone_url_override:
            if re.match(r"^[a-z][a-z0-9+.\-]*://", self.spec, re.I) or "@" in self.spec:
                raise InvalidRepoSpec(
                    "only github.com repositories are supported (or pass a path to a local clone)"
                )
            raise InvalidRepoSpec(
                f"{self.spec!r} is not an existing directory or a GitHub repo "
                "(expected https://github.com/owner/repo or owner/repo)"
            )
        if shutil.which("git") is None:
            raise CloneError("git is not installed or not on PATH")

        self.used_temp_clone = True
        self._install_signal_handlers()
        atexit.register(self._cleanup)
        try:
            self._tmp_dir = tempfile.mkdtemp(prefix="modularity-")  # mode 0700
            dest = os.path.join(self._tmp_dir, "repo")
            url = self._clone_url_override or repo.clone_url  # type: ignore[union-attr]
            log.info("Cloning %s ...", repo.web_url if repo else url)
            _clone(url, dest, self.branch, self.clone_timeout)
            commit, branch, _ = _describe_checkout(dest)
            return RepoInfo(
                dest,
                "clone",
                self.spec,
                url=repo.web_url if repo else None,
                commit=commit,
                branch=branch or self.branch,
            )
        except BaseException:
            self._cleanup()
            raise

    def __exit__(self, exc_type, exc, tb) -> bool:
        self._cleanup()
        return False

    # -- internals ---------------------------------------------------------
    def _cleanup(self) -> None:
        self._restore_signal_handlers()
        tmp, self._tmp_dir = self._tmp_dir, None
        if tmp is None:
            return
        log.info("Removing temporary clone ...")
        if secure_rmtree(tmp):
            log.debug("removed %s", tmp)
            try:
                atexit.unregister(self._cleanup)
            except Exception:  # pragma: no cover - defensive
                pass
        else:
            self.cleanup_ok = False
            self.leftover_path = tmp
            log.error("FAILED to remove temporary directory: %s", tmp)

    def _install_signal_handlers(self) -> None:
        def _raise_exit(signum, _frame):
            raise SystemExit(128 + signum)

        for name in ("SIGTERM", "SIGHUP"):
            sig = getattr(signal, name, None)
            if sig is None:
                continue
            try:
                self._old_handlers[sig] = signal.signal(sig, _raise_exit)
            except (ValueError, OSError):  # not in main thread / unsupported
                pass

    def _restore_signal_handlers(self) -> None:
        for sig, handler in self._old_handlers.items():
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):
                pass
        self._old_handlers.clear()
