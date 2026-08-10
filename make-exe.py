#!/usr/bin/env python3
"""把 bridge.exe 的 PE Subsystem 改为 2（Windows GUI），实现静默无窗口。
用法：python make-exe.py [exe路径，默认本目录 bridge.exe]"""
import struct
import sys
import os

p = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bridge.exe')
with open(p, 'r+b') as f:
    head = f.read(0x40)
    e_lfanew = struct.unpack_from('<I', head, 0x3C)[0]
    off = e_lfanew + 4 + 20 + 68  # PE sig + FileHeader + OptionalHeader.Subsystem
    f.seek(off)
    cur = struct.unpack('<H', f.read(2))[0]
    f.seek(off)
    f.write(struct.pack('<H', 2))
print(f'{os.path.basename(p)}: Subsystem {cur} -> 2 (GUI)')
