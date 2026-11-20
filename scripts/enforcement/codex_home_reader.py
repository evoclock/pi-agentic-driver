#!/usr/bin/env python3
"""Return only CODEX_HOME for one macOS PID; never print the raw process environment."""

import ctypes
import os
import sys


class Unavailable(Exception):
    pass


def extract_home(data):
    if len(data) < 8 or len(data) > 1024 * 1024 or data[-1] != 0:
        raise Unavailable()
    argc = int.from_bytes(data[:4], sys.byteorder, signed=True)
    if argc < 1 or argc > 256:
        raise Unavailable()
    fields = data[4:].split(b'\x00')
    if not fields[0]:
        raise Unavailable()
    index = 1
    while index < len(fields) and not fields[index]:
        index += 1
    if index + argc >= len(fields):
        raise Unavailable()
    args = fields[index:index + argc]
    if any(not arg for arg in args):
        raise Unavailable()
    homes = []
    for value in fields[index + argc:]:
        if not value:  # applev begins after the environment's empty separator
            break
        if value.startswith(b'CODEX_HOME='):
            homes.append(value[len(b'CODEX_HOME='):])
    if len(homes) != 1 or not homes[0] or len(homes[0]) > 1024:
        raise Unavailable()
    return homes[0].decode('utf-8', 'strict')


def process_args(pid):
    # Darwin CTL_KERN / KERN_PROCARGS2. Keep the full buffer in this short-lived
    # helper only; the parent receives exactly one requested environment value.
    if sys.platform != 'darwin':
        raise Unavailable()
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                           ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                           ctypes.c_void_p, ctypes.c_size_t]
    argmax_mib = (ctypes.c_int * 2)(1, 8)
    argmax = ctypes.c_int(0)
    argmax_size = ctypes.c_size_t(ctypes.sizeof(argmax))
    if (libc.sysctl(argmax_mib, 2, ctypes.byref(argmax), ctypes.byref(argmax_size), None, 0)
            or not 0 < argmax.value <= 1024 * 1024):
        raise Unavailable()
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t(argmax.value)
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0):
        raise Unavailable()
    return buffer.raw[:size.value]


def main(argv):
    try:
        if len(argv) == 2 and argv[1].isascii() and argv[1].isdigit() and 1 < int(argv[1]) <= 2147483647:
            raw = process_args(int(argv[1]))
        else:
            raise Unavailable()
        value = extract_home(raw)
        os.write(1, value.encode('utf-8'))
        return 0
    except Exception:
        os.write(2, b'Codex process value unavailable\n')
        return 2


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
