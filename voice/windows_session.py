"""Windows session lock observation backed by documented WTS APIs.

This module never infers lock state from a visible window.  The initial state
comes from ``WTSQuerySessionInformationW(WTSSessionInfoEx)`` and subsequent
changes come from ``WM_WTSSESSION_CHANGE`` after registering a private hidden
window with ``WTSRegisterSessionNotification``.
"""

from __future__ import annotations

import ctypes
import os
import sys
import threading
from ctypes import wintypes
from dataclasses import dataclass, field
from typing import Callable, Protocol

from .interaction import SessionState


WM_WTSSESSION_CHANGE = 0x02B1
WTS_SESSION_LOCK = 0x7
WTS_SESSION_UNLOCK = 0x8
NOTIFY_FOR_THIS_SESSION = 0
WTS_CURRENT_SESSION = 0xFFFFFFFF
WTS_SESSION_INFO_EX = 25
WTS_SESSIONSTATE_LOCK = 0
WTS_SESSIONSTATE_UNLOCK = 1
WTS_SESSIONSTATE_UNKNOWN = 0xFFFFFFFF


class SessionObservationError(RuntimeError):
    """Raised when the documented Windows session APIs cannot be initialized."""


def state_from_session_flags(
    flags: int,
    *,
    windows_version: tuple[int, int],
) -> SessionState:
    """Translate WTSINFOEX SessionFlags, including the documented Win7 defect."""

    if flags & 0xFFFFFFFF == WTS_SESSIONSTATE_UNKNOWN:
        return SessionState.UNKNOWN

    # Microsoft documents that Windows 7 / Server 2008 R2 reversed these two
    # flags.  Ultron targets newer Windows, but keeping the mapping explicit
    # avoids silently interpreting the old result with the wrong authority.
    windows_7 = windows_version == (6, 1)
    locked_flag = WTS_SESSIONSTATE_UNLOCK if windows_7 else WTS_SESSIONSTATE_LOCK
    unlocked_flag = WTS_SESSIONSTATE_LOCK if windows_7 else WTS_SESSIONSTATE_UNLOCK
    if flags == locked_flag:
        return SessionState.LOCKED
    if flags == unlocked_flag:
        return SessionState.UNLOCKED
    return SessionState.UNKNOWN


def state_from_wts_change(change_code: int) -> SessionState | None:
    """Map only authoritative lock/unlock WTS notifications."""

    if change_code == WTS_SESSION_LOCK:
        return SessionState.LOCKED
    if change_code == WTS_SESSION_UNLOCK:
        return SessionState.UNLOCKED
    return None


class SessionNotificationBackend(Protocol):
    def query_current_state(self) -> SessionState: ...

    def watch(
        self,
        on_state: Callable[[SessionState], None],
        stop_event: threading.Event,
    ) -> None: ...


class _WtsInfoExLevel1(ctypes.Structure):
    _fields_ = [
        ("session_id", wintypes.DWORD),
        ("session_state", ctypes.c_int),
        ("session_flags", wintypes.LONG),
        ("window_station_name", wintypes.WCHAR * 33),
        ("user_name", wintypes.WCHAR * 21),
        ("domain_name", wintypes.WCHAR * 18),
        ("logon_time", ctypes.c_longlong),
        ("connect_time", ctypes.c_longlong),
        ("disconnect_time", ctypes.c_longlong),
        ("last_input_time", ctypes.c_longlong),
        ("current_time", ctypes.c_longlong),
        ("incoming_bytes", wintypes.DWORD),
        ("outgoing_bytes", wintypes.DWORD),
        ("incoming_frames", wintypes.DWORD),
        ("outgoing_frames", wintypes.DWORD),
        ("incoming_compressed_bytes", wintypes.DWORD),
        ("outgoing_compressed_bytes", wintypes.DWORD),
    ]


class _WtsInfoExLevelUnion(ctypes.Union):
    # The complete structure matters here: its LARGE_INTEGER fields give the
    # union 8-byte alignment on 64-bit Windows, so WTSINFOEX.Data starts at the
    # same offset as the SDK definition.
    _fields_ = [("level1", _WtsInfoExLevel1)]


class _WtsInfoExPrefix(ctypes.Structure):
    _fields_ = [
        ("level", wintypes.DWORD),
        ("data", _WtsInfoExLevelUnion),
    ]


class CtypesWtsSessionBackend:
    """Current-user WTS query plus a hidden-window notification loop."""

    poll_interval_seconds = 0.05

    def _require_windows(self) -> None:
        if os.name != "nt":
            raise SessionObservationError("WTS session observation requires Windows")

    def query_current_state(self) -> SessionState:
        self._require_windows()
        wtsapi32 = ctypes.WinDLL("wtsapi32", use_last_error=True)
        query = wtsapi32.WTSQuerySessionInformationW
        query.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(wintypes.DWORD),
        ]
        query.restype = wintypes.BOOL
        free_memory = wtsapi32.WTSFreeMemory
        free_memory.argtypes = [ctypes.c_void_p]
        free_memory.restype = None

        buffer = ctypes.c_void_p()
        size = wintypes.DWORD()
        succeeded = query(
            None,
            WTS_CURRENT_SESSION,
            WTS_SESSION_INFO_EX,
            ctypes.byref(buffer),
            ctypes.byref(size),
        )
        if not succeeded or not buffer.value:
            error = ctypes.get_last_error()
            raise SessionObservationError(f"WTS session query failed ({error})")

        try:
            if size.value < ctypes.sizeof(_WtsInfoExPrefix):
                raise SessionObservationError("WTS returned an incomplete session record")
            record = ctypes.cast(buffer, ctypes.POINTER(_WtsInfoExPrefix)).contents
            if record.level != 1:
                return SessionState.UNKNOWN
            version = sys.getwindowsversion()
            return state_from_session_flags(
                int(record.data.level1.session_flags),
                windows_version=(version.major, version.minor),
            )
        finally:
            free_memory(buffer)

    def watch(
        self,
        on_state: Callable[[SessionState], None],
        stop_event: threading.Event,
    ) -> None:
        self._require_windows()
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        wtsapi32 = ctypes.WinDLL("wtsapi32", use_last_error=True)

        wndproc_type = ctypes.WINFUNCTYPE(
            ctypes.c_ssize_t,
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
        )

        class WndClass(ctypes.Structure):
            _fields_ = [
                ("style", wintypes.UINT),
                ("wndproc", wndproc_type),
                ("class_extra", ctypes.c_int),
                ("window_extra", ctypes.c_int),
                ("instance", wintypes.HINSTANCE),
                ("icon", wintypes.HANDLE),
                ("cursor", wintypes.HANDLE),
                ("background", wintypes.HANDLE),
                ("menu_name", wintypes.LPCWSTR),
                ("class_name", wintypes.LPCWSTR),
            ]

        user32.DefWindowProcW.argtypes = [
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
        ]
        user32.DefWindowProcW.restype = ctypes.c_ssize_t

        @wndproc_type
        def window_proc(hwnd: int, message: int, wparam: int, lparam: int) -> int:
            if message == WM_WTSSESSION_CHANGE:
                state = state_from_wts_change(int(wparam))
                if state is not None:
                    on_state(state)
            return int(user32.DefWindowProcW(hwnd, message, wparam, lparam))

        get_module = kernel32.GetModuleHandleW
        get_module.argtypes = [wintypes.LPCWSTR]
        get_module.restype = wintypes.HMODULE
        instance = get_module(None)
        class_name = f"UltronWtsSessionObserver_{id(self):x}"
        window_class = WndClass(
            0,
            window_proc,
            0,
            0,
            instance,
            None,
            None,
            None,
            None,
            class_name,
        )

        user32.RegisterClassW.argtypes = [ctypes.POINTER(WndClass)]
        user32.RegisterClassW.restype = wintypes.ATOM
        atom = user32.RegisterClassW(ctypes.byref(window_class))
        if not atom:
            error = ctypes.get_last_error()
            raise SessionObservationError(f"WTS observer window registration failed ({error})")

        user32.CreateWindowExW.argtypes = [
            wintypes.DWORD,
            wintypes.LPCWSTR,
            wintypes.LPCWSTR,
            wintypes.DWORD,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.HWND,
            wintypes.HMENU,
            wintypes.HINSTANCE,
            ctypes.c_void_p,
        ]
        user32.CreateWindowExW.restype = wintypes.HWND
        message_only_parent = wintypes.HWND(ctypes.c_void_p(-3).value)
        hwnd = user32.CreateWindowExW(
            0,
            class_name,
            "Ultron WTS Session Observer",
            0,
            0,
            0,
            0,
            0,
            message_only_parent,
            None,
            instance,
            None,
        )
        if not hwnd:
            error = ctypes.get_last_error()
            user32.UnregisterClassW(class_name, instance)
            raise SessionObservationError(f"WTS observer window creation failed ({error})")

        register = wtsapi32.WTSRegisterSessionNotification
        register.argtypes = [wintypes.HWND, wintypes.DWORD]
        register.restype = wintypes.BOOL
        unregister = wtsapi32.WTSUnRegisterSessionNotification
        unregister.argtypes = [wintypes.HWND]
        unregister.restype = wintypes.BOOL
        if not register(hwnd, NOTIFY_FOR_THIS_SESSION):
            error = ctypes.get_last_error()
            user32.DestroyWindow(hwnd)
            user32.UnregisterClassW(class_name, instance)
            raise SessionObservationError(f"WTS notification registration failed ({error})")

        user32.PeekMessageW.argtypes = [
            ctypes.POINTER(wintypes.MSG),
            wintypes.HWND,
            wintypes.UINT,
            wintypes.UINT,
            wintypes.UINT,
        ]
        user32.PeekMessageW.restype = wintypes.BOOL
        message = wintypes.MSG()
        try:
            while not stop_event.is_set():
                while user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
                    user32.TranslateMessage(ctypes.byref(message))
                    user32.DispatchMessageW(ctypes.byref(message))
                stop_event.wait(self.poll_interval_seconds)
        finally:
            unregister(hwnd)
            user32.DestroyWindow(hwnd)
            user32.UnregisterClassW(class_name, instance)


@dataclass(slots=True)
class WindowsSessionObserver:
    """Thread-safe lock-state provider for the current interactive session."""

    backend: SessionNotificationBackend = field(default_factory=CtypesWtsSessionBackend)
    _state: SessionState = field(default=SessionState.UNKNOWN, init=False)
    _callbacks: list[Callable[[SessionState], None]] = field(default_factory=list, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)
    _stop_event: threading.Event = field(default_factory=threading.Event, init=False)
    _thread: threading.Thread | None = field(default=None, init=False)
    _last_error: Exception | None = field(default=None, init=False)

    def current_state(self) -> SessionState:
        # Notifications keep the HUD current, but an activation decision must
        # never trust a potentially stale cached UNLOCKED value. Re-query the
        # documented WTS session flag synchronously and fail closed on error.
        try:
            state = self.backend.query_current_state()
        except Exception as error:
            with self._lock:
                self._last_error = error
            state = SessionState.UNKNOWN
        else:
            with self._lock:
                self._last_error = None
        self._accept_state(state)
        with self._lock:
            return self._state

    @property
    def last_error(self) -> Exception | None:
        with self._lock:
            return self._last_error

    def subscribe(self, callback: Callable[[SessionState], None]) -> Callable[[], None]:
        with self._lock:
            self._callbacks.append(callback)

        def unsubscribe() -> None:
            with self._lock:
                if callback in self._callbacks:
                    self._callbacks.remove(callback)

        return unsubscribe

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._accept_state(SessionState.UNKNOWN)

        self._thread = threading.Thread(
            target=self._watch,
            name="UltronWtsSessionObserver",
            daemon=True,
        )
        self._thread.start()
        self.current_state()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout)

    def _watch(self) -> None:
        try:
            self.backend.watch(self._accept_state, self._stop_event)
        except Exception as error:
            with self._lock:
                self._last_error = error
            self._accept_state(SessionState.UNKNOWN)

    def _accept_state(self, state: SessionState) -> None:
        with self._lock:
            changed = state is not self._state
            self._state = state
            callbacks = tuple(self._callbacks) if changed else ()
        for callback in callbacks:
            callback(state)
