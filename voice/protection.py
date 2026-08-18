"""Windows user-scoped protection primitives for authentication artifacts."""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes
from typing import Protocol


class DataProtector(Protocol):
    def protect(self, plaintext: bytes) -> bytes: ...

    def unprotect(self, ciphertext: bytes) -> bytes: ...


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


class WindowsUserDpapiProtector:
    """Protect bytes with the current Windows user's DPAPI key.

    CRYPTPROTECT_LOCAL_MACHINE is intentionally not used: authentication data
    must not become decryptable by every account on the computer.
    """

    _UI_FORBIDDEN = 0x1

    def __init__(self) -> None:
        if os.name != "nt":
            raise OSError("Windows DPAPI is available only on Windows")
        self._crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._crypt32.CryptProtectData.argtypes = [
            ctypes.POINTER(_DataBlob),
            wintypes.LPCWSTR,
            ctypes.POINTER(_DataBlob),
            wintypes.LPVOID,
            wintypes.LPVOID,
            wintypes.DWORD,
            ctypes.POINTER(_DataBlob),
        ]
        self._crypt32.CryptProtectData.restype = wintypes.BOOL
        self._crypt32.CryptUnprotectData.argtypes = [
            ctypes.POINTER(_DataBlob),
            ctypes.POINTER(wintypes.LPWSTR),
            ctypes.POINTER(_DataBlob),
            wintypes.LPVOID,
            wintypes.LPVOID,
            wintypes.DWORD,
            ctypes.POINTER(_DataBlob),
        ]
        self._crypt32.CryptUnprotectData.restype = wintypes.BOOL
        self._kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
        self._kernel32.LocalFree.restype = wintypes.HLOCAL

    def protect(self, plaintext: bytes) -> bytes:
        return self._transform(plaintext, protect=True)

    def unprotect(self, ciphertext: bytes) -> bytes:
        return self._transform(ciphertext, protect=False)

    def _transform(self, data: bytes, *, protect: bool) -> bytes:
        if not data:
            raise ValueError("DPAPI input cannot be empty")
        buffer = ctypes.create_string_buffer(data, len(data))
        input_blob = _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
        output_blob = _DataBlob()

        if protect:
            succeeded = self._crypt32.CryptProtectData(
                ctypes.byref(input_blob),
                "Ultron speaker authentication data",
                None,
                None,
                None,
                self._UI_FORBIDDEN,
                ctypes.byref(output_blob),
            )
        else:
            description = wintypes.LPWSTR()
            succeeded = self._crypt32.CryptUnprotectData(
                ctypes.byref(input_blob),
                ctypes.byref(description),
                None,
                None,
                None,
                self._UI_FORBIDDEN,
                ctypes.byref(output_blob),
            )
            if description:
                self._kernel32.LocalFree(description)

        if not succeeded:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return ctypes.string_at(output_blob.pbData, output_blob.cbData)
        finally:
            self._kernel32.LocalFree(output_blob.pbData)


def default_auth_directory() -> str:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise OSError("LOCALAPPDATA is unavailable; refusing insecure authentication storage")
    return os.path.join(local_app_data, "Ultron", "Auth")
