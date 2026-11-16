#!/usr/bin/env python3
"""Sets the few /etc/bluetooth/main.conf options CarHUD needs, leaving everything else as it is.

    python3 bt_mainconf.py /etc/bluetooth/main.conf CarHUD
"""
import re
import sys

path, name = sys.argv[1], sys.argv[2]
WANT = {
    # a car audio device (class 0x240420: audio + rendering services, car audio) that phones see as "CarHUD"
    'General': {'Name': name, 'Class': '0x240420', 'DiscoverableTimeout': '180', 'FastConnectable': 'true', 'JustWorksRepairing': 'always'},
    # on at boot, and keep trying to reconnect a phone that drops
    'Policy': {'AutoEnable': 'true', 'ReconnectAttempts': '7', 'ReconnectIntervals': '1,2,4,8,16,32,64'},
}

text = open(path).read()
out, seen, sect = [], set(), None


def flush(section):
    if section in WANT:
        out.extend('%s = %s' % (k, v) for k, v in WANT[section].items() if (section, k) not in seen)


for line in text.split('\n'):
    m = re.match(r'^\s*\[(\w+)\]', line)
    if m:
        flush(sect)
        sect = m.group(1)
        out.append(line)
        continue
    m = re.match(r'^\s*#?\s*(\w+)\s*=', line)
    if sect in WANT and m and m.group(1) in WANT[sect] and (sect, m.group(1)) not in seen:
        out.append('%s = %s' % (m.group(1), WANT[sect][m.group(1)]))
        seen.add((sect, m.group(1)))
        continue
    out.append(line)
flush(sect)
for s, kv in WANT.items():
    if not re.search(r'^\s*\[%s\]' % s, text, re.M):
        out += ['', '[%s]' % s] + ['%s = %s' % (k, v) for k, v in kv.items()]
open(path, 'w').write('\n'.join(out).rstrip('\n') + '\n')
print('bluetooth: main.conf set for CarHUD')
