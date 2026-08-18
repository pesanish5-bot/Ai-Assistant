"""Best-effort Windows controller for the existing loopback Ultron HUD."""

from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import threading
import time
import urllib.parse
from ctypes import wintypes
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Protocol, Sequence


SW_RESTORE = 9
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_SHOWWINDOW = 0x0040
HWND_TOP = 0
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2


class HudLaunchError(RuntimeError):
    """Raised when the dedicated per-user HUD cannot be launched."""


class ProcessHandle(Protocol):
    pid: int

    def poll(self) -> int | None: ...


class ProcessLauncher(Protocol):
    def launch(self, command: Sequence[str]) -> ProcessHandle: ...


class WindowApi(Protocol):
    def find_window(self, process_id: int | None, title_hint: str) -> int | None: ...

    def show_window(self, hwnd: int, command: int) -> None: ...

    def set_window_position(self, hwnd: int, insert_after: int, flags: int) -> bool: ...

    def set_foreground_window(self, hwnd: int) -> bool: ...


class SubprocessLauncher:
    def launch(self, command: Sequence[str]) -> ProcessHandle:
        return subprocess.Popen(list(command), close_fds=True)


class CtypesWindowApi:
    """Small user32 adapter; it never synthesizes keyboard or mouse input."""

    def __init__(self) -> None:
        if os.name != "nt":
            raise HudLaunchError("Ultron global HUD activation requires Windows")
        self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    def _is_edge_process(self, process_id: int) -> bool:
        process_query_limited_information = 0x1000
        open_process = self._kernel32.OpenProcess
        open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        open_process.restype = wintypes.HANDLE
        handle = open_process(process_query_limited_information, False, process_id)
        if not handle:
            return False
        try:
            buffer = ctypes.create_unicode_buffer(32_768)
            size = wintypes.DWORD(len(buffer))
            query_name = self._kernel32.QueryFullProcessImageNameW
            query_name.argtypes = [
                wintypes.HANDLE,
                wintypes.DWORD,
                wintypes.LPWSTR,
                ctypes.POINTER(wintypes.DWORD),
            ]
            query_name.restype = wintypes.BOOL
            if not query_name(handle, 0, buffer, ctypes.byref(size)):
                return False
            return Path(buffer.value).name.casefold() == "msedge.exe"
        finally:
            self._kernel32.CloseHandle(handle)

    def find_window(self, process_id: int | None, title_hint: str) -> int | None:
        matches: list[tuple[int, bool]] = []
        enum_proc_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user32 = self._user32

        @enum_proc_type
        def visitor(hwnd: int, _lparam: int) -> bool:
            window_pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(window_pid))
            title_length = user32.GetWindowTextLengthW(hwnd)
            title = ""
            if title_length:
                buffer = ctypes.create_unicode_buffer(title_length + 1)
                user32.GetWindowTextW(hwnd, buffer, len(buffer))
                title = buffer.value
            pid_match = process_id is not None and int(window_pid.value) == process_id
            normalized_title = title.casefold()
            normalized_hint = title_hint.casefold()
            title_match = bool(title_hint) and normalized_title in {
                normalized_hint,
                f"{normalized_hint} - microsoft edge",
            }
            # Edge may share a broker/renderer process across unrelated windows.
            # A PID match alone is therefore never enough: every accepted window
            # must have Ultron's exact local title and be owned by msedge.exe.
            process_matches = process_id is None or pid_match
            if (
                process_matches
                and title_match
                and self._is_edge_process(int(window_pid.value))
            ):
                matches.append((int(hwnd), bool(user32.IsWindowVisible(hwnd))))
            return True

        user32.EnumWindows(enum_proc_type(visitor), 0)
        if not matches:
            return None
        matches.sort(key=lambda item: item[1], reverse=True)
        return matches[0][0]

    def show_window(self, hwnd: int, command: int) -> None:
        self._user32.ShowWindow(wintypes.HWND(hwnd), command)

    def set_window_position(self, hwnd: int, insert_after: int, flags: int) -> bool:
        return bool(
            self._user32.SetWindowPos(
                wintypes.HWND(hwnd),
                wintypes.HWND(ctypes.c_void_p(insert_after).value),
                0,
                0,
                0,
                0,
                flags,
            )
        )

    def set_foreground_window(self, hwnd: int) -> bool:
        return bool(self._user32.SetForegroundWindow(wintypes.HWND(hwnd)))


@dataclass(frozen=True, slots=True)
class WindowActivationResult:
    hwnd: int
    foreground_acquired: bool
    fallback_used: bool


@dataclass(slots=True)
class Win32WindowController:
    api: WindowApi = field(default_factory=CtypesWindowApi)
    fallback_hold_seconds: float = 5.0
    demotion_scheduler: Callable[[float, Callable[[], None]], None] | None = None
    _activation_generation: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        if self.fallback_hold_seconds < 0:
            raise ValueError("fallback_hold_seconds cannot be negative")
        if self.demotion_scheduler is None:
            self.demotion_scheduler = self._schedule_demotion

    @staticmethod
    def _schedule_demotion(delay: float, callback: Callable[[], None]) -> None:
        timer = threading.Timer(delay, callback)
        timer.daemon = True
        timer.start()

    def find_window(self, process_id: int | None, title_hint: str) -> int | None:
        return self.api.find_window(process_id, title_hint)

    def activate(self, hwnd: int) -> WindowActivationResult:
        self._activation_generation += 1
        generation = self._activation_generation
        self.api.show_window(hwnd, SW_RESTORE)
        self.api.set_window_position(
            hwnd,
            HWND_TOP,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        )
        foreground = self.api.set_foreground_window(hwnd)
        fallback_used = not foreground
        if fallback_used:
            # Windows intentionally limits foreground stealing.  A temporary
            # topmost pulse makes the requested HUD visible without simulated
            # input, then immediately restores normal z-order behavior.
            self.api.set_window_position(
                hwnd,
                HWND_TOPMOST,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            )
            # Keep the requested HUD visibly above foreground-restricting apps
            # while returning immediately so voice listening can start. The
            # delayed demotion uses only supported window APIs and never
            # synthesizes user input.
            def demote_if_fresh() -> None:
                if generation != self._activation_generation:
                    return
                self.api.set_window_position(
                    hwnd,
                    HWND_NOTOPMOST,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                )

            assert self.demotion_scheduler is not None
            self.demotion_scheduler(self.fallback_hold_seconds, demote_if_fresh)
        return WindowActivationResult(hwnd, foreground, fallback_used)


@dataclass(frozen=True, slots=True)
class HudOpenResult:
    ready: bool
    launched: bool
    reused: bool
    foreground_acquired: bool
    fallback_used: bool
    hwnd: int | None = None
    error: str | None = None


def discover_edge_executable(
    environment: Mapping[str, str] | None = None,
) -> Path:
    environment = os.environ if environment is None else environment
    candidates: list[Path] = []
    for variable in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
        root = environment.get(variable)
        if root:
            candidates.append(Path(root) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
    discovered = shutil.which("msedge.exe")
    if discovered:
        candidates.append(Path(discovered))
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise HudLaunchError("Microsoft Edge was not found")


@dataclass(slots=True)
class EdgeAppHudController:
    """Launch once, then keep reusing/focusing the warm Edge app window."""

    hud_url: str = "http://localhost:3000"
    title_hint: str = "Ultron HUD [Local]"
    edge_executable: Path | None = None
    launcher: ProcessLauncher = field(default_factory=SubprocessLauncher)
    windows: Win32WindowController = field(default_factory=Win32WindowController)
    window_attempts: int = 30
    retry_interval_seconds: float = 0.1
    _process: ProcessHandle | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        parsed = urllib.parse.urlparse(self.hud_url)
        if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("HUD URL must be loopback HTTP")
        if self.window_attempts < 1:
            raise ValueError("window_attempts must be positive")
        if self.retry_interval_seconds < 0:
            raise ValueError("retry_interval_seconds cannot be negative")

    def open_or_focus(self) -> HudOpenResult:
        process = self._process
        process_alive = process is not None and process.poll() is None
        process_id = process.pid if process_alive else None
        if not process_alive:
            # Reuse only a title-matching window owned by Microsoft Edge.  The
            # real Win32 adapter verifies the executable and will not steal a
            # similarly titled Brave/Chrome tab.
            hwnd = self.windows.find_window(None, self.title_hint)
            if hwnd is not None:
                activation = self.windows.activate(hwnd)
                return HudOpenResult(
                    ready=True,
                    launched=False,
                    reused=True,
                    foreground_acquired=activation.foreground_acquired,
                    fallback_used=activation.fallback_used,
                    hwnd=hwnd,
                )
        if process_alive:
            hwnd = self.windows.find_window(process_id, self.title_hint)
            if hwnd is not None:
                activation = self.windows.activate(hwnd)
                return HudOpenResult(
                    ready=True,
                    launched=False,
                    reused=True,
                    foreground_acquired=activation.foreground_acquired,
                    fallback_used=activation.fallback_used,
                    hwnd=hwnd,
                )
            # A retained Edge broker without its app window is not a warm HUD.
            # Relaunch the dedicated app instead of leaving activation inert.
            self._process = None
            process_alive = False
            process_id = None

        launched = False
        if not process_alive:
            try:
                edge = self.edge_executable or discover_edge_executable()
                self._process = self.launcher.launch(
                    [str(edge), f"--app={self.hud_url}", "--new-window", "--no-first-run"]
                )
                process_id = self._process.pid
                launched = True
            except Exception as error:
                return HudOpenResult(False, False, False, False, False, error=str(error))

        for attempt in range(self.window_attempts):
            hwnd = self.windows.find_window(process_id, self.title_hint)
            if hwnd is None and launched:
                # Edge may hand --app to an already-running Edge process and
                # let the launcher PID exit.  The executable-checked lookup
                # still identifies the dedicated app window safely.
                hwnd = self.windows.find_window(None, self.title_hint)
            if hwnd is not None:
                activation = self.windows.activate(hwnd)
                return HudOpenResult(
                    ready=True,
                    launched=launched,
                    reused=not launched,
                    foreground_acquired=activation.foreground_acquired,
                    fallback_used=activation.fallback_used,
                    hwnd=hwnd,
                )
            if attempt + 1 < self.window_attempts and self.retry_interval_seconds:
                time.sleep(self.retry_interval_seconds)

        return HudOpenResult(
            ready=False,
            launched=launched,
            reused=not launched,
            foreground_acquired=False,
            fallback_used=False,
            error="Ultron HUD window was not found",
        )
