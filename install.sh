#!/bin/bash
# CarHUD installer for a Raspberry Pi running Raspberry Pi OS (Lite or Desktop).
#
#   First install:   sudo bash install.sh
#   Updates:         carhud update   (runs this with --update; only redoes what changed)
#
# Safe to run again at any time. Log: /var/log/carhud-install.log
set -euo pipefail

MODE=install; [ "${1:-}" = "--update" ] && MODE=update
[ "$(id -u)" = 0 ] || { echo "Run with sudo:  sudo bash $0"; exit 1; }
DIR=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
LOG=/var/log/carhud-install.log
exec > >(tee -a "$LOG") 2>&1
step() { echo; echo "==== $* ===="; }
trap 'echo; echo "!!!! Stopped at line $LINENO. See $LOG; fix the problem and run it again."' ERR

USER_NAME=${SUDO_USER:-}
if [ -z "$USER_NAME" ] || [ "$USER_NAME" = root ]; then USER_NAME=$(id -nu 1000); fi
USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)
BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot
STATE=/var/lib/carhud; mkdir -p "$STATE"
CONF=/etc/carhud.conf
VERSION=$(cat "$DIR/VERSION")
changed() {   # changed <name> <value>: true when value differs from last time (and remembers it)
    local f="$STATE/$1"
    if [ -f "$f" ] && [ "$(cat "$f")" = "$2" ]; then return 1; fi
    echo "$2" > "$f.new"; return 0
}
remember() { [ -f "$STATE/$1.new" ] && mv "$STATE/$1.new" "$STATE/$1"; true; }
echo "CarHUD $VERSION: $MODE for user '$USER_NAME' from $DIR ($(date))"

# ---------------------------------------------------------------------------------------------
step "1/9  System packages"
PKGS="xserver-xorg xinit x11-xserver-utils xinput lightdm lightdm-gtk-greeter openbox obconf tint2 pcmanfm lxterminal mousepad
unclutter git curl ca-certificates nodejs python3 python3-pil fonts-dejavu-core fonts-noto-color-emoji openssh-server alsa-utils"
export DEBIAN_FRONTEND=noninteractive
if [ "$MODE" = install ] || changed packages "$PKGS"; then
    apt-get update
    [ "$MODE" = install ] && apt-get -y full-upgrade
    # shellcheck disable=SC2086
    apt-get install -y --no-install-recommends $PKGS
    apt-get install -y chromium || apt-get install -y chromium-browser
    changed packages "$PKGS" || true; remember packages
else
    echo "no package changes"
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 16 ] || { echo "Node $NODE_MAJOR is too old (need 16+)"; exit 1; }

# ---------------------------------------------------------------------------------------------
step "2/9  SSH, auto-login desktop, Pi settings"
systemctl enable --now ssh >/dev/null 2>&1 || true
groupadd -f autologin
usermod -aG autologin,video,input,plugdev,dialout,audio "$USER_NAME"     # dialout: the OBD-II cable
mkdir -p /etc/lightdm/lightdm.conf.d
cat > /etc/lightdm/lightdm.conf.d/50-carhud.conf <<EOF
[Seat:*]
autologin-user=$USER_NAME
autologin-session=openbox
user-session=openbox
xserver-command=X -s 0 -dpms
EOF
systemctl set-default graphical.target >/dev/null
systemctl enable lightdm >/dev/null 2>&1 || true
CFG=$BOOT/config.txt
if [ -f "$CFG" ]; then
    grep -q '^dtoverlay=vc4-kms-v3d' "$CFG" || echo 'dtoverlay=vc4-kms-v3d' >> "$CFG"
    grep -q '^display_auto_detect=1' "$CFG" || echo 'display_auto_detect=1' >> "$CFG"
fi
if [ -f /etc/dphys-swapfile ] && ! grep -q '^CONF_SWAPSIZE=1024' /etc/dphys-swapfile; then
    sed -i 's/^#\?CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
    systemctl restart dphys-swapfile || true
fi

# ---------------------------------------------------------------------------------------------
step "3/9  Settings ($CONF)"
DEFAULT_CONF=$(sed "s#/home/USER#$USER_HOME#g" "$DIR/system/carhud.conf")
if [ ! -f "$CONF" ]; then
    echo "$DEFAULT_CONF" > "$CONF"; echo "created $CONF"
else
    # add settings this version brought in, leave every existing one as it is
    printf '%s\n' "$DEFAULT_CONF" > /tmp/carhud-default.conf
    python3 - "$CONF" /tmp/carhud-default.conf "$VERSION" <<'PY'
import re, sys
conf, default, version = sys.argv[1:4]
have = open(conf).read()
keys = set(re.findall(r'^\s*([A-Z][A-Z0-9_]*)\s*=', have, re.M))
added, comments = [], []
for line in open(default).read().splitlines():
    m = re.match(r'^([A-Z][A-Z0-9_]*)=', line)
    if line.startswith('#') and not line.startswith('# ----'): comments.append(line); continue
    if m and m.group(1) not in keys: added.extend(comments + [line])
    comments = []
# v1 pointed the second screen at a placeholder page that no longer exists
have = re.sub(r'^CARPLAY_URL=file:///opt/carhud/carplay-placeholder\.html\s*$', 'CARPLAY_URL=', have, flags=re.M)
if added:
    have = have.rstrip('\n') + '\n\n# ---- added by CarHUD ' + version + ' ----\n' + '\n'.join(added) + '\n'
    print('added: ' + ', '.join(l.split('=')[0] for l in added if not l.startswith('#')))
else:
    print('no new settings')
open(conf, 'w').write(have)
PY
fi
conf_get() { sed -n "s/^$1=//p" "$CONF" | tail -n1 | sed 's/^"\(.*\)"$/\1/'; }
EVA_DIR=$(conf_get EVA_DIR); EVA_DIR=${EVA_DIR:-/opt/evahud}
USER_APPS=$(conf_get USER_APPS_DIR); USER_APPS=${USER_APPS:-$USER_HOME/carhud-apps}
MEDIA=$(conf_get MEDIA_DIR); MEDIA=${MEDIA:-$USER_HOME/Music}

# ---------------------------------------------------------------------------------------------
step "4/9  HUD project (idrive7-EVAHUD)"
EVA_URL=https://github.com/PenguinDukeYDAuto/idrive7-EVAHUD.git
EVA_REF=$(cat "$DIR/eva.ref")
EGIT="git -c safe.directory=$EVA_DIR -C $EVA_DIR"
if [ ! -d "$EVA_DIR/.git" ]; then git clone --quiet "$EVA_URL" "$EVA_DIR"; fi
if [ "$($EGIT rev-parse HEAD)" != "$EVA_REF" ]; then
    $EGIT cat-file -e "$EVA_REF^{commit}" 2>/dev/null || $EGIT fetch --quiet origin "$EVA_REF" || $EGIT fetch --quiet origin
    $EGIT checkout --quiet -f "$EVA_REF"
    echo "HUD project at $(echo "$EVA_REF" | cut -c1-7)"
else
    echo "HUD project already at $(echo "$EVA_REF" | cut -c1-7)"
fi

step "5/9  HUD fonts and layouts"
FONTS=$EVA_DIR/tools/fonts-src; SUBDIR=$STATE/fonts
mkdir -p "$FONTS" "$SUBDIR"
BARLOW=https://raw.githubusercontent.com/jpt/barlow/main/fonts/ttf
for f in BarlowCondensed-Bold BarlowCondensed-SemiBold BarlowSemiCondensed-SemiBold BarlowSemiCondensed-Medium Barlow-Medium; do
    [ -s "$FONTS/$f.ttf" ] || curl -fsSL --retry 3 -o "$FONTS/$f.ttf" "$BARLOW/$f.ttf"
done
# your own MatissePro, if you have a licence: put it in /var/lib/carhud/fonts/ (or v1's /opt/carhud.old/fonts/)
MATISSE_FILE=$(ls "$SUBDIR"/MatissePro-EB.otf /opt/carhud.old/fonts/MatissePro-EB.otf /boot/firmware/carhud-setup/fonts/MatissePro-EB.otf 2>/dev/null | head -n1 || true)
if [ -n "$MATISSE_FILE" ]; then
    cp -n "$MATISSE_FILE" "$SUBDIR/" 2>/dev/null || true
    export MATISSE=$SUBDIR/MatissePro-EB.otf EVA_FONT_SCALES=""
else
    SUB=$SUBDIR/ShipporiMinchoB1-ExtraBold.ttf
    [ -s "$SUB" ] || curl -fsSL --retry 3 -o "$SUB" https://raw.githubusercontent.com/google/fonts/main/ofl/shipporiminchob1/ShipporiMinchoB1-ExtraBold.ttf
    # its glyphs run taller than MatissePro's: a few text sizes shrink to pass the layout checks
    export MATISSE=$SUB EVA_FONT_SCALES="label=0.8,line=0.8,motto=0.9,word=0.9"
fi
BAKE_KEY="$EVA_REF $(basename "$MATISSE") $EVA_FONT_SCALES $(sha1sum "$DIR/tools/eva_bake.py" | cut -c1-12)"
if changed fonts "$BAKE_KEY" || [ -z "$(ls -A "$EVA_DIR/apps/eva_hud/hud/fonts" 2>/dev/null)" ]; then
    echo "baking with $(basename "$MATISSE") (a few minutes on a Pi 3)..."
    python3 "$DIR/tools/eva_bake.py" "$EVA_DIR"
    changed fonts "$BAKE_KEY" || true; remember fonts
else
    echo "fonts already baked"
fi
chown -R "$USER_NAME:$USER_NAME" "$EVA_DIR"

# ---------------------------------------------------------------------------------------------
step "6/9  Commands"
chown -R "$USER_NAME:$USER_NAME" "$DIR"
chmod +x "$DIR/bin/carhud" "$DIR/system/carhud-screens" "$DIR/system/carhud-mode" "$DIR/system/carhud-update"
# v1 copied these in; v2 links them to this checkout so updates reach them
rm -f /usr/local/bin/carhud-screens /usr/local/bin/carhud-mode
ln -sf "$DIR/bin/carhud" /usr/local/bin/carhud
ln -sf "$DIR/system/carhud-screens" /usr/local/bin/carhud-screens
ln -sf "$DIR/system/carhud-mode" /usr/local/bin/carhud-mode
ln -sf "$DIR/system/carhud-update" /usr/local/bin/carhud-update

step "7/9  Desk apps, music folder, USB rules"
sudo -u "$USER_NAME" mkdir -p "$USER_APPS" "$MEDIA"
if [ ! -e "$USER_APPS/README.txt" ]; then
    sudo -u "$USER_NAME" cp "$DIR/desk/template/README.txt" "$USER_APPS/README.txt"
    sudo -u "$USER_NAME" cp -r "$DIR/desk/template/hello" "$USER_APPS/hello"
fi
cat > /etc/udev/rules.d/52-carhud.rules <<'EOF'
# Carlinkit-style CarPlay USB dongles, for a future player app
SUBSYSTEM=="usb", ATTR{idVendor}=="1314", ATTR{idProduct}=="152[01]", MODE="0660", GROUP="plugdev"
EOF
rm -f /etc/udev/rules.d/52-carplay-dongle.rules
udevadm control --reload-rules || true

step "8/9  Desktop session"
OB=$USER_HOME/.config/openbox
sudo -u "$USER_NAME" mkdir -p "$OB"
cat > "$OB/autostart" <<'EOF'
# Openbox autostart (CarHUD)
xset s off -dpms s noblank &
tint2 &
pcmanfm --desktop &
. /etc/carhud.conf
[ "$AUTOSTART" = 1 ] && carhud-screens &
EOF
[ -f "$OB/rc.xml" ] || cp /etc/xdg/openbox/rc.xml "$OB/rc.xml"
chown -R "$USER_NAME:$USER_NAME" "$USER_HOME/.config"

# ---------------------------------------------------------------------------------------------
step "9/9  CarHUD service"
if systemctl list-unit-files evahud.service >/dev/null 2>&1 && [ -f /etc/systemd/system/evahud.service ]; then
    echo "replacing v1's evahud service"
    systemctl disable --now evahud >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/evahud.service
fi
sed -e "s#@USER@#$USER_NAME#g" -e "s#@DIR@#$DIR#g" "$DIR/system/carhud.service" > /etc/systemd/system/carhud.service
systemctl daemon-reload
systemctl enable carhud >/dev/null 2>&1
systemctl restart carhud
echo "carhud service (re)started"

# the screens script changed: reopen the screens if the desktop is up
SCREENS_SUM=$(sha1sum "$DIR/system/carhud-screens" | cut -c1-12)
if changed screens "$SCREENS_SUM"; then
    if [ "$MODE" = update ] && pgrep -x Xorg >/dev/null && grep -q '^AUTOSTART=1' "$CONF"; then
        sudo -u "$USER_NAME" env DISPLAY=:0 XAUTHORITY="$USER_HOME/.Xauthority" setsid carhud-screens >/dev/null 2>&1 < /dev/null &
        echo "reopening the screens"
    fi
    changed screens "$SCREENS_SUM" || true; remember screens
fi

trap - ERR
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

=====================================================================
 CarHUD $VERSION $( [ "$MODE" = update ] && echo updated || echo installed ).
EOF
if [ "$MODE" = install ]; then cat <<EOF
 Reboot to start the desktop and screens:   sudo reboot
EOF
fi
cat <<EOF
 Control panel:  http://$(hostname).local:$(conf_get HUD_PORT)/   or   http://${IP:-<pi-ip>}:$(conf_get HUD_PORT)/
 Commands:       carhud help
 Update later:   carhud update
=====================================================================
EOF
