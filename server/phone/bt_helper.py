#!/usr/bin/env python3
"""CarHUD Bluetooth helper: talks to BlueZ (the Linux Bluetooth service) over D-Bus.

The carhud server runs this and talks to it with one JSON object per line:
  out (stdout): state, pair-request, pair-done, notification, notification-removed, log
  in  (stdin):  discoverable, pair-reply, media, volume, connect, disconnect, forget, notif-action

What it does:
  - makes the Pi a car audio device named "CarHUD" that phones can pair with; you confirm the
    pairing code on the desk screen
  - trusts paired phones and reconnects to the last one by itself
  - music: playback runs through bluez-alsa; this reads what is playing (AVRCP) and sends
    play / pause / next / previous / volume
  - iPhone notifications (Apple Notification Center Service over Bluetooth LE): title, message,
    app, and answering / declining calls from the screen. Android has no equivalent.

Environment: CARHUD_BT_NAME (CarHUD), CARHUD_BT_ADAPTER (first one), CARHUD_BT_ANCS (1),
             CARHUD_BT_STATE (file for the last connected phones), CARHUD_BT_BUS (system | session, for tests)
"""
import json
import os
import struct
import sys
import time

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BLUEZ = 'org.bluez'
ADAPTER = 'org.bluez.Adapter1'
DEVICE = 'org.bluez.Device1'
PLAYER = 'org.bluez.MediaPlayer1'
TRANSPORT = 'org.bluez.MediaTransport1'
BATTERY = 'org.bluez.Battery1'
CHAR = 'org.bluez.GattCharacteristic1'
PROPS = 'org.freedesktop.DBus.Properties'
OM = 'org.freedesktop.DBus.ObjectManager'

ANCS_SERVICE = '7905f431-b5ce-4e99-a40f-4b1e122d00d0'
ANCS_NS = '9fbf120d-6301-42d9-8c58-25e699a21dbd'      # notification source
ANCS_CP = '69d1d8f3-45e1-49a8-9821-9bbdfdaad9d9'      # control point
ANCS_DS = '22eac6e9-24d6-4bb5-be44-b36ace7c7bfb'      # data source
CATEGORIES = ['other', 'incoming-call', 'missed-call', 'voicemail', 'social', 'schedule', 'email', 'news',
              'health', 'finance', 'location', 'entertainment']
APP_NAMES = {'com.apple.MobileSMS': 'Messages', 'com.apple.mobilephone': 'Phone', 'com.apple.mobilemail': 'Mail',
             'com.apple.mobilecal': 'Calendar', 'com.apple.reminders': 'Reminders', 'com.apple.facetime': 'FaceTime',
             'net.whatsapp.WhatsApp': 'WhatsApp', 'com.burbn.instagram': 'Instagram', 'com.hammerandchisel.discord': 'Discord',
             'com.toyopagroup.picaboo': 'Snapchat', 'com.spotify.client': 'Spotify', 'com.google.Maps': 'Google Maps',
             'com.apple.Maps': 'Maps', 'com.facebook.Messenger': 'Messenger', 'ph.telegra.Telegraph': 'Telegram'}

NAME = os.environ.get('CARHUD_BT_NAME', 'CarHUD')
WANT_ADAPTER = os.environ.get('CARHUD_BT_ADAPTER', '')
ANCS_ON = os.environ.get('CARHUD_BT_ANCS', '1') == '1'
STATE_FILE = os.environ.get('CARHUD_BT_STATE', os.path.expanduser('~/.carhud/bluetooth.json'))
RECONNECT_EVERY = int(os.environ.get('CARHUD_BT_RECONNECT', '15'))
# accept pairing by itself while the pairing window (Pair a phone) is open: you confirm the code on the phone
AUTO_PAIR = os.environ.get('CARHUD_BT_AUTOPAIR', '1') == '1'


def out(msg):
    sys.stdout.write(json.dumps(msg, default=str) + '\n')
    sys.stdout.flush()


def log(level, text):
    out({'t': 'log', 'level': level, 'text': 'bluetooth: ' + text})


def py(v):
    """D-Bus values -> plain Python"""
    if isinstance(v, (dbus.Array, list)):
        if getattr(v, 'signature', None) == 'y':
            return bytes(int(b) for b in v)
        return [py(x) for x in v]
    if isinstance(v, (dbus.Dictionary, dict)):
        return {str(k): py(x) for k, x in v.items()}
    if isinstance(v, dbus.Boolean):
        return bool(v)
    if isinstance(v, (dbus.Byte, dbus.Int16, dbus.UInt16, dbus.Int32, dbus.UInt32, dbus.Int64, dbus.UInt64)):
        return int(v)
    if isinstance(v, dbus.Double):
        return float(v)
    if isinstance(v, (dbus.String, dbus.ObjectPath)):
        return str(v)
    return v


def ignore(*_):
    pass


class Agent(dbus.service.Object):
    """Pairing. While the pairing window you opened is on (Pair a phone), a phone that asks is accepted
    and you confirm the code on the phone. Otherwise the screens ask (desk, control panel, phone app)."""
    PATH = '/carhud/agent'

    def __init__(self, bus, owner):
        super().__init__(bus, self.PATH)
        self.owner = owner
        self.pending = None

    def _ask(self, device, passkey, ok, err):
        d = self.owner.devices.get(str(device), {})
        name = d.get('Alias') or d.get('Name') or 'a phone'
        code = None if passkey is None else '%06d' % int(passkey)
        if AUTO_PAIR and time.time() < self.owner.window_until:
            log('info', 'pairing with %s%s: accepted (the pairing window is open)' % (name, ' (code %s)' % code if code else ''))
            out({'t': 'pair-request', 'address': d.get('Address', ''), 'name': name, 'passkey': code, 'auto': True})
            ok()
            self.owner.trust(str(device))
            out({'t': 'pair-done', 'ok': True, 'auto': True})
            return
        if self.pending:
            self.pending['err'](dbus.exceptions.DBusException('busy', name='org.bluez.Error.Rejected'))
        log('info', 'pairing request from %s%s: waiting for a yes on a screen (30 s)' % (name, ' (code %s)' % code if code else ''))
        req = {'device': str(device), 'ok': ok, 'err': err}
        req['timer'] = GLib.timeout_add_seconds(30, self._timeout)
        self.pending = req
        out({'t': 'pair-request', 'address': d.get('Address', ''), 'name': d.get('Alias') or d.get('Name') or 'a phone',
             'passkey': None if passkey is None else '%06d' % int(passkey)})

    def _timeout(self):
        if self.pending:
            log('info', 'pairing not confirmed in 30 s, declined')
            self.pending['err'](dbus.exceptions.DBusException('timed out', name='org.bluez.Error.Rejected'))
            self.pending = None
            out({'t': 'pair-done', 'ok': False})
        return False

    def reply(self, accept):
        p, self.pending = self.pending, None
        if not p:
            return
        GLib.source_remove(p['timer'])
        if accept:
            p['ok']()
            self.owner.trust(p['device'])
        else:
            p['err'](dbus.exceptions.DBusException('declined', name='org.bluez.Error.Rejected'))
        out({'t': 'pair-done', 'ok': bool(accept)})

    @dbus.service.method('org.bluez.Agent1', in_signature='', out_signature='')
    def Release(self):
        pass

    @dbus.service.method('org.bluez.Agent1', in_signature='os', out_signature='')
    def AuthorizeService(self, device, uuid):
        return       # the phone asks for audio, notifications, ...: yes once paired

    @dbus.service.method('org.bluez.Agent1', in_signature='o', out_signature='s')
    def RequestPinCode(self, device):
        return '0000'

    @dbus.service.method('org.bluez.Agent1', in_signature='o', out_signature='u')
    def RequestPasskey(self, device):
        return dbus.UInt32(0)

    @dbus.service.method('org.bluez.Agent1', in_signature='ouq', out_signature='')
    def DisplayPasskey(self, device, passkey, entered):
        pass

    @dbus.service.method('org.bluez.Agent1', in_signature='os', out_signature='')
    def DisplayPinCode(self, device, code):
        pass

    @dbus.service.method('org.bluez.Agent1', in_signature='ou', out_signature='', async_callbacks=('ok', 'err'))
    def RequestConfirmation(self, device, passkey, ok, err):
        self._ask(device, passkey, ok, err)

    @dbus.service.method('org.bluez.Agent1', in_signature='o', out_signature='', async_callbacks=('ok', 'err'))
    def RequestAuthorization(self, device, ok, err):
        self._ask(device, None, ok, err)

    @dbus.service.method('org.bluez.Agent1', in_signature='', out_signature='')
    def Cancel(self):
        if self.pending:
            GLib.source_remove(self.pending['timer'])
            self.pending = None
            out({'t': 'pair-done', 'ok': False})


class Advert(dbus.service.Object):
    """Bluetooth LE advertisement asking iPhones for their notification service (ANCS)."""
    PATH = '/carhud/advert'

    def __init__(self, bus):
        super().__init__(bus, self.PATH)

    def props(self):
        return {'Type': 'peripheral', 'LocalName': dbus.String(NAME),
                'SolicitUUIDs': dbus.Array([ANCS_SERVICE], signature='s'), 'Includes': dbus.Array(['tx-power'], signature='s')}

    @dbus.service.method(PROPS, in_signature='s', out_signature='a{sv}')
    def GetAll(self, iface):
        return self.props()

    @dbus.service.method('org.bluez.LEAdvertisement1', in_signature='', out_signature='')
    def Release(self):
        pass


class Ancs:
    """Apple Notification Center Service client for one iPhone."""

    def __init__(self, owner, dev_path, chars):
        self.o = owner
        self.dev = dev_path
        self.ns, self.cp, self.ds = chars[ANCS_NS], chars[ANCS_CP], chars[ANCS_DS]
        self.queue = []          # requests waiting for their turn on the control point
        self.busy = None         # the request whose answer is arriving on the data source
        self.buf = b''
        self.apps = {}
        self.notes = {}

    def start(self):
        log('info', 'iPhone notifications: subscribing')
        bus = self.o.bus
        ds = dbus.Interface(bus.get_object(BLUEZ, self.ds), CHAR)
        ns = dbus.Interface(bus.get_object(BLUEZ, self.ns), CHAR)
        # data source first, so no answer is missed; then the notification source either way
        def ns_on(*_):
            ns.StartNotify(reply_handler=lambda: log('info', 'iPhone notifications on'),
                           error_handler=lambda e: log('warn', 'notification source: %s' % e))

        def ds_failed(e):
            log('warn', 'data source: %s (notifications will come without their text)' % e)
            ns_on()
        ds.StartNotify(reply_handler=ns_on, error_handler=ds_failed)

    def on_value(self, path, value):
        if path == self.ns:
            self.on_ns(value)
        elif path == self.ds:
            self.on_ds(value)

    def on_ns(self, v):
        if len(v) < 8:
            return
        event, flags, cat, _count, uid = struct.unpack('<BBBBI', v[:8])
        if event == 2:
            self.notes.pop(uid, None)
            out({'t': 'notification-removed', 'uid': uid})
            return
        self.notes[uid] = {'uid': uid, 'category': CATEGORIES[cat] if cat < len(CATEGORIES) else 'other',
                           'silent': bool(flags & 1), 'important': bool(flags & 2), 'preexisting': bool(flags & 4),
                           'hasPositive': bool(flags & 8), 'hasNegative': bool(flags & 16), 'modified': event == 1}
        # app id, title (64), subtitle (64), message (240), date, positive and negative action labels
        attrs = [(0, None), (1, 64), (2, 64), (3, 240), (5, None), (6, None), (7, None)]
        req = struct.pack('<BI', 0, uid) + b''.join(struct.pack('<B', a) + (struct.pack('<H', n) if n else b'') for a, n in attrs)
        self.request({'kind': 'note', 'uid': uid, 'n': len(attrs), 'bytes': req})

    def request(self, r):
        self.queue.append(r)
        self.pump()

    def pump(self):
        if self.busy or not self.queue:
            return
        self.busy = self.queue.pop(0)
        self.buf = b''
        self.busy['timer'] = GLib.timeout_add_seconds(5, self._stuck)
        self.write(self.busy['bytes'])

    def _stuck(self):
        log('warn', 'iPhone did not answer a notification request')
        self.busy = None
        self.pump()
        return False

    def write(self, data, done=None):
        ch = dbus.Interface(self.o.bus.get_object(BLUEZ, self.cp), CHAR)
        ch.WriteValue(dbus.Array(data, signature='y'), {'type': dbus.String('request')},
                      reply_handler=done or ignore, error_handler=lambda e: log('warn', 'control point: %s' % e))

    def on_ds(self, v):
        if not self.busy:
            return
        self.buf += v
        r = self.busy
        parsed = self.parse(r)
        if parsed is None:
            return       # more to come
        GLib.source_remove(r['timer'])
        self.busy = None
        if r['kind'] == 'note':
            self.got_note(r['uid'], parsed)
        else:
            name = parsed.get(0, b'').decode('utf-8', 'replace')
            self.apps[r['app']] = name
            for n in list(self.notes.values()):
                if n.get('app') == r['app'] and n.get('sent'):
                    n['appName'] = name
                    out(dict(n, t='notification'))
        self.pump()

    def parse(self, r):
        """attribute id -> bytes once the whole answer is in, None while it is still arriving"""
        b = self.buf
        if r['kind'] == 'note':
            if len(b) < 5:
                return None
            i = 5
        else:
            z = b.find(b'\0', 1)
            if z < 0:
                return None
            i = z + 1
        attrs = {}
        for _ in range(r['n']):
            if len(b) < i + 3:
                return None
            aid, ln = struct.unpack('<BH', b[i:i + 3])
            if len(b) < i + 3 + ln:
                return None
            attrs[aid] = b[i + 3:i + 3 + ln]
            i += 3 + ln
        return attrs

    def got_note(self, uid, a):
        n = self.notes.get(uid)
        if not n:
            return
        s = lambda k: a.get(k, b'').decode('utf-8', 'replace')
        app = s(0)
        n.update({'app': app, 'title': s(1), 'subtitle': s(2), 'message': s(3), 'date': s(5),
                  'positive': s(6) if n['hasPositive'] else '', 'negative': s(7) if n['hasNegative'] else '', 'sent': True})
        n['appName'] = self.apps.get(app) or APP_NAMES.get(app) or app.split('.')[-1]
        out(dict(n, t='notification'))
        if app and app not in self.apps and app not in APP_NAMES:
            self.apps[app] = ''
            self.request({'kind': 'app', 'app': app, 'n': 1, 'bytes': b'\x01' + app.encode() + b'\x00\x00'})

    def action(self, uid, positive):
        self.write(struct.pack('<BIB', 2, int(uid), 0 if positive else 1))


class Bt:
    def __init__(self, bus):
        self.bus = bus
        self.om = dbus.Interface(bus.get_object(BLUEZ, '/'), OM)
        self.adapter = None
        self.devices = {}      # path -> Device1 props (+ battery)
        self.players = {}      # path -> MediaPlayer1 props
        self.transports = {}   # path -> MediaTransport1 props
        self.chars = {}        # path -> {uuid, device}
        self.ancs = {}         # device path -> Ancs
        self.agent = Agent(bus, self)
        self.advert = Advert(bus) if ANCS_ON else None
        self.adv_on = False
        self.emit_timer = None
        self.recent = self.load_recent()
        self.reconnecting = False
        self.window_until = 0
        bus.add_signal_receiver(self.on_added, 'InterfacesAdded', OM, BLUEZ)
        bus.add_signal_receiver(self.on_removed, 'InterfacesRemoved', OM, BLUEZ)
        bus.add_signal_receiver(self.on_changed, 'PropertiesChanged', PROPS, BLUEZ, path_keyword='path')
        bus.add_signal_receiver(self.on_owner, 'NameOwnerChanged', 'org.freedesktop.DBus', arg0=BLUEZ)

    # ---------- startup ----------
    def setup(self):
        try:
            objs = self.om.GetManagedObjects()
        except dbus.exceptions.DBusException as e:
            log('warn', 'BlueZ not running (%s); waiting for it' % e.get_dbus_name())
            return False
        adapters = sorted(str(p) for p, i in objs.items() if ADAPTER in i)
        if not adapters:
            log('warn', 'no Bluetooth adapter; waiting for one')
            return False
        self.adapter = next((a for a in adapters if WANT_ADAPTER and a.endswith('/' + WANT_ADAPTER)), adapters[0])
        for p, i in objs.items():
            self.on_added(p, i, quiet=True)
        ad = self.props_if(self.adapter, ADAPTER)
        try:
            ad.Set(ADAPTER, 'Powered', dbus.Boolean(True))
            ad.Set(ADAPTER, 'Alias', dbus.String(NAME))
            ad.Set(ADAPTER, 'Pairable', dbus.Boolean(True))
            ad.Set(ADAPTER, 'PairableTimeout', dbus.UInt32(0))
        except dbus.exceptions.DBusException as e:
            log('warn', 'adapter setup: %s' % e)
        try:
            mgr = dbus.Interface(self.bus.get_object(BLUEZ, '/org/bluez'), 'org.bluez.AgentManager1')
            try:
                mgr.UnregisterAgent(Agent.PATH)
            except dbus.exceptions.DBusException:
                pass
            mgr.RegisterAgent(Agent.PATH, 'DisplayYesNo')
            mgr.RequestDefaultAgent(Agent.PATH)
        except dbus.exceptions.DBusException as e:
            log('error', 'cannot register the pairing agent: %s' % e)
        self.advertise()
        log('info', 'ready on %s as "%s"' % (self.adapter.split('/')[-1], NAME))
        self.emit()
        GLib.timeout_add_seconds(RECONNECT_EVERY, self.reconnect_tick)
        GLib.timeout_add(1000, self.position_tick)
        GLib.timeout_add_seconds(2, lambda: self.reconnect_tick() and False)
        return True

    def props_if(self, path, _iface=None):
        return dbus.Interface(self.bus.get_object(BLUEZ, path), PROPS)

    def advertise(self):
        if not self.advert or self.adv_on or not self.adapter:
            return
        try:
            mgr = dbus.Interface(self.bus.get_object(BLUEZ, self.adapter), 'org.bluez.LEAdvertisingManager1')
            mgr.RegisterAdvertisement(Advert.PATH, {}, reply_handler=lambda: log('info', 'advertising for iPhone notifications'),
                                      error_handler=lambda e: log('warn', 'LE advertising: %s' % e))
            self.adv_on = True
        except dbus.exceptions.DBusException as e:
            log('warn', 'LE advertising not available: %s' % e)

    # ---------- object tracking ----------
    def on_owner(self, name, old, new):
        if new and not old:
            log('info', 'BlueZ started')
            self.devices.clear(); self.players.clear(); self.transports.clear(); self.chars.clear(); self.ancs.clear()
            self.adv_on = False
            GLib.timeout_add_seconds(1, lambda: self.setup() and False)
        elif old and not new:
            log('warn', 'BlueZ stopped')
            self.adapter = None
            self.emit()

    def on_added(self, path, ifaces, quiet=False):
        path = str(path)
        if DEVICE in ifaces:
            d = py(ifaces[DEVICE])
            if self.adapter and not path.startswith(self.adapter + '/'):
                return
            self.devices[path] = d
            if BATTERY in ifaces:
                d['Battery'] = py(ifaces[BATTERY]).get('Percentage')
        if BATTERY in ifaces and path in self.devices:
            self.devices[path]['Battery'] = py(ifaces[BATTERY]).get('Percentage')
        if PLAYER in ifaces:
            self.players[path] = py(ifaces[PLAYER])
            self.players[path]['_seen'] = time.time()
            self.players[path]['_posAt'] = time.time()
        if TRANSPORT in ifaces:
            self.transports[path] = py(ifaces[TRANSPORT])
        if CHAR in ifaces:
            c = py(ifaces[CHAR])
            self.chars[path] = {'uuid': c.get('UUID', '').lower(), 'service': c.get('Service', '')}
            self.check_ancs()
        if not quiet:
            self.emit()

    def on_removed(self, path, ifaces):
        path = str(path)
        if DEVICE in ifaces:
            self.devices.pop(path, None)
        if PLAYER in ifaces:
            self.players.pop(path, None)
        if TRANSPORT in ifaces:
            self.transports.pop(path, None)
        if CHAR in ifaces:
            self.chars.pop(path, None)
            for dev in list(self.ancs):
                if path.startswith(dev + '/'):
                    del self.ancs[dev]
                    log('info', 'iPhone notifications off')
        if ADAPTER in ifaces and path == self.adapter:
            self.adapter = None
            log('warn', 'Bluetooth adapter gone')
        self.emit()

    def on_changed(self, iface, changed, invalidated, path=None):
        path, iface = str(path), str(iface)
        ch = py(changed)
        if iface == DEVICE and path in self.devices:
            was = self.devices[path].get('Connected')
            self.devices[path].update(ch)
            if ch.get('Paired'):
                self.trust(path)
            if ch.get('Connected') and not was:
                self.remember(path)
                log('info', '%s connected' % self.devices[path].get('Alias'))
            elif 'Connected' in ch and not ch['Connected'] and was:
                log('info', '%s disconnected' % self.devices[path].get('Alias'))
                self.ancs.pop(path, None)
        elif iface == BATTERY and path in self.devices:
            self.devices[path]['Battery'] = ch.get('Percentage', self.devices[path].get('Battery'))
        elif iface == PLAYER and path in self.players:
            p = self.players[path]
            p.update(ch)
            p['_seen'] = time.time()
            if 'Position' in ch or 'Status' in ch:
                p['_posAt'] = time.time()
        elif iface == TRANSPORT and path in self.transports:
            self.transports[path].update(ch)
        elif iface == ADAPTER and path == self.adapter:
            pass
        elif iface == CHAR and 'Value' in ch:
            for dev, a in self.ancs.items():
                if path.startswith(dev + '/'):
                    a.on_value(path, ch['Value'])
            return
        else:
            return
        self.emit()

    def check_ancs(self):
        if not ANCS_ON:
            return
        by_dev = {}
        for p, c in self.chars.items():
            if c['uuid'] in (ANCS_NS, ANCS_CP, ANCS_DS):
                dev = p.rsplit('/', 2)[0]
                by_dev.setdefault(dev, {})[c['uuid']] = p
        for dev, ch in by_dev.items():
            if len(ch) == 3 and dev not in self.ancs:
                self.ancs[dev] = Ancs(self, dev, ch)
                GLib.timeout_add(300, lambda d=dev: (self.ancs.get(d) and self.ancs[d].start()) and False)

    # ---------- phones ----------
    def trust(self, path):
        try:
            self.props_if(path).Set(DEVICE, 'Trusted', dbus.Boolean(True))
        except dbus.exceptions.DBusException as e:
            log('warn', 'trust: %s' % e)

    def load_recent(self):
        try:
            with open(STATE_FILE) as f:
                return json.load(f).get('recent', [])
        except (OSError, ValueError):
            return []

    def remember(self, path):
        addr = self.devices.get(path, {}).get('Address')
        if not addr:
            return
        self.recent = [addr] + [a for a in self.recent if a != addr]
        try:
            os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
            with open(STATE_FILE, 'w') as f:
                json.dump({'recent': self.recent[:10]}, f)
        except OSError:
            pass

    def reconnect_tick(self):
        """No phone connected: try the paired ones, most recent first (phones also reconnect by themselves)."""
        if not self.adapter or self.reconnecting or any(d.get('Connected') for d in self.devices.values()):
            return True
        order = {a: i for i, a in enumerate(self.recent)}
        cands = sorted((p for p, d in self.devices.items() if d.get('Paired') and d.get('Trusted')),
                       key=lambda p: order.get(self.devices[p].get('Address'), 99))
        if not cands:
            return True

        def attempt(i):
            if i >= len(cands) or any(d.get('Connected') for d in self.devices.values()):
                self.reconnecting = False
                return
            dev = dbus.Interface(self.bus.get_object(BLUEZ, cands[i]), DEVICE)
            dev.Connect(reply_handler=lambda: setattr(self, 'reconnecting', False),
                        error_handler=lambda e: attempt(i + 1), timeout=20)
        self.reconnecting = True
        attempt(0)
        return True

    def find(self, address):
        return next((p for p, d in self.devices.items() if d.get('Address', '').lower() == str(address).lower()), None)

    # ---------- media ----------
    def player(self):
        connected = [p for p, d in self.devices.items() if d.get('Connected')]
        mine = [p for p in self.players if any(p.startswith(c + '/') for c in connected)] or list(self.players)
        if not mine:
            return None
        playing = [p for p in mine if self.players[p].get('Status') == 'playing']
        return max(playing or mine, key=lambda p: self.players[p].get('_seen', 0))

    def transport(self):
        connected = [p for p, d in self.devices.items() if d.get('Connected')]
        mine = [p for p in self.transports if any(p.startswith(c + '/') for c in connected)]
        return mine[0] if mine else None

    def position_tick(self):
        p = self.player()
        if p and self.players[p].get('Status') == 'playing':
            try:
                pos = self.props_if(p).Get(PLAYER, 'Position')
                self.players[p]['Position'] = int(pos)
                self.players[p]['_posAt'] = time.time()
            except dbus.exceptions.DBusException:
                pass
        return True

    # ---------- state out ----------
    def emit(self):
        if self.emit_timer:
            return
        self.emit_timer = GLib.timeout_add(80, self._emit)

    def _emit(self):
        self.emit_timer = None
        a = None
        if self.adapter:
            try:
                ap = py(self.props_if(self.adapter).GetAll(ADAPTER))
                a = {'name': ap.get('Alias'), 'address': ap.get('Address'), 'powered': ap.get('Powered'),
                     'discoverable': ap.get('Discoverable'), 'discoverableTimeout': ap.get('DiscoverableTimeout')}
            except dbus.exceptions.DBusException:
                a = None
        devs = [{'address': d.get('Address'), 'name': d.get('Alias') or d.get('Name'), 'paired': bool(d.get('Paired')),
                 'trusted': bool(d.get('Trusted')), 'connected': bool(d.get('Connected')), 'battery': d.get('Battery'),
                 'icon': d.get('Icon'), 'notifications': p in self.ancs}
                for p, d in self.devices.items() if d.get('Paired') or d.get('Connected')]
        media = None
        pp = self.player()
        if pp:
            p = self.players[pp]
            t = p.get('Track') or {}
            media = {'app': p.get('Name'), 'status': p.get('Status'), 'title': t.get('Title'), 'artist': t.get('Artist'),
                     'album': t.get('Album'), 'duration': t.get('Duration'), 'position': p.get('Position'),
                     'positionAt': int(p.get('_posAt', time.time()) * 1000)}
        tp = self.transport()
        vol = self.transports[tp].get('Volume') if tp else None
        out({'t': 'state', 'adapter': a, 'devices': devs, 'media': media, 'volume': vol})
        return False

    # ---------- commands from the server ----------
    def command(self, m):
        t = m.get('t')
        try:
            if t == 'discoverable':
                secs = int(m.get('seconds', 180))
                if not self.adapter:
                    return log('error', 'no Bluetooth adapter, so phones cannot find the Pi (is Bluetooth blocked? try: carhud phone --check)')
                self.window_until = time.time() + secs if m.get('on', True) else 0
                ad = self.props_if(self.adapter)
                ad.Set(ADAPTER, 'Powered', dbus.Boolean(True))
                ad.Set(ADAPTER, 'Pairable', dbus.Boolean(True))
                ad.Set(ADAPTER, 'DiscoverableTimeout', dbus.UInt32(secs))
                ad.Set(ADAPTER, 'Discoverable', dbus.Boolean(bool(m.get('on', True))))
                log('info', ('visible to phones for %d s' % secs) if m.get('on', True) else 'hidden from new phones')
                self.advertise()
            elif t == 'pair-reply':
                self.agent.reply(bool(m.get('accept')))
            elif t == 'media':
                p = self.player()
                if not p:
                    return log('warn', 'no music player on the connected phone')
                action = m.get('action')
                if action == 'toggle':
                    action = 'pause' if self.players[p].get('Status') == 'playing' else 'play'
                method = {'play': 'Play', 'pause': 'Pause', 'next': 'Next', 'previous': 'Previous', 'stop': 'Stop'}[action]
                getattr(dbus.Interface(self.bus.get_object(BLUEZ, p), PLAYER), method)(reply_handler=ignore, error_handler=lambda e: log('warn', '%s: %s' % (method, e)))
            elif t == 'volume':
                tp = self.transport()
                if not tp:
                    return log('warn', 'no audio connection for volume')
                v = max(0, min(127, int(m.get('value', 64))))
                self.props_if(tp).Set(TRANSPORT, 'Volume', dbus.UInt16(v))
            elif t in ('connect', 'disconnect'):
                p = self.find(m.get('address'))
                if p:
                    dev = dbus.Interface(self.bus.get_object(BLUEZ, p), DEVICE)
                    getattr(dev, 'Connect' if t == 'connect' else 'Disconnect')(reply_handler=ignore, error_handler=lambda e: log('warn', '%s: %s' % (t, e)), timeout=20)
            elif t == 'forget':
                p = self.find(m.get('address'))
                if p:
                    dbus.Interface(self.bus.get_object(BLUEZ, self.adapter), ADAPTER).RemoveDevice(p)
                    log('info', 'forgot %s' % m.get('address'))
            elif t == 'notif-action':
                a = next(iter(self.ancs.values()), None)
                if a:
                    a.action(m.get('uid'), bool(m.get('positive')))
            elif t == 'refresh':
                self.emit()
        except (dbus.exceptions.DBusException, KeyError, TypeError, ValueError) as e:
            log('warn', '%s failed: %s' % (t, e))
        self.emit()


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus() if os.environ.get('CARHUD_BT_BUS') == 'session' else dbus.SystemBus()
    bt = Bt(bus)
    loop = GLib.MainLoop()

    def try_setup():
        if bt.adapter:
            return False
        return not bt.setup()      # keep retrying every 5 s until there is an adapter
    if not bt.setup():
        out({'t': 'state', 'adapter': None, 'devices': [], 'media': None, 'volume': None})
        GLib.timeout_add_seconds(5, try_setup)

    buf = {'s': ''}

    def on_stdin(fd, cond):
        if cond & (GLib.IO_HUP | GLib.IO_ERR):
            loop.quit()
            return False
        data = os.read(fd, 65536).decode('utf-8', 'replace')
        if not data:
            loop.quit()
            return False
        buf['s'] += data
        while '\n' in buf['s']:
            line, buf['s'] = buf['s'].split('\n', 1)
            if line.strip():
                try:
                    bt.command(json.loads(line))
                except ValueError:
                    log('warn', 'bad command: ' + line[:80])
        return True
    GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_stdin)
    loop.run()


if __name__ == '__main__':
    main()
