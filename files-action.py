# "Send with Yonder" in Files (Nautilus), part of the Yonder plugin for
# Omarchy (org.getyonder.yonder). The plugin's "Share and Files" setting
# copies this file into the Files extensions folder as yonder_send.py and
# removes it again; change the setting, not this file.
#
# It hands the selection to the plugin's helper, which opens Yonder's panel
# in the bar. Omarchy runs nothing of a plugin when the plugin is removed,
# so this file looks for the plugin itself: when the plugin is gone it puts
# LocalSend's action back, if "In place of LocalSend" had put it aside, takes
# the plugin's rows out of Omarchy's menu file, and deletes itself.

import glob
import os
import shutil

from gi import require_version

require_version("Nautilus", "4.1")

from gi.repository import GObject, Gio, Nautilus

CONFIG = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
HELPER = os.path.join(CONFIG, "omarchy", "plugins", "org.getyonder.yonder", "share")
MENU = os.path.join(CONFIG, "omarchy", "extensions", "omarchy-menu.jsonc")
# The marks of the helper's block in the menu file, as the helper writes them.
MARK_BEGIN = "// >>> org.getyonder.yonder"
MARK_END = "// <<< org.getyonder.yonder"
HERE = os.path.dirname(os.path.abspath(__file__))
LOCALSEND = os.path.join(HERE, "localsend.py")
ASIDE = LOCALSEND + ".yonder-aside"


def retire_menu():
    """Take the helper's block out of the menu file, as its "off" does."""
    with open(MENU, encoding="utf-8") as menu:
        lines = menu.read().split("\n")
    begins = [i for i, line in enumerate(lines) if MARK_BEGIN in line]
    ends = [i for i, line in enumerate(lines) if MARK_END in line]
    # Damaged marks: nothing is removed, as with the helper.
    if len(begins) != 1 or len(ends) != 1 or ends[0] < begins[0]:
        return
    rest = lines[: begins[0]] + lines[ends[0] + 1 :]
    # A file the helper made, with nothing else in it by now, goes again.
    if ", new file)" in lines[begins[0]] and not "".join(rest).strip("{} \t\r"):
        os.remove(MENU)
        return
    # Written by way of a temporary file in the same folder and a rename, so
    # that a stop in the middle leaves the old file. A link is followed to
    # the file it names, so that it stays a link; the file keeps its mode.
    target = os.path.realpath(MENU)
    part = os.path.join(os.path.dirname(target), ".omarchy-menu.yonder-tmp")
    try:
        with open(part, "w", encoding="utf-8") as menu:
            menu.write("\n".join(rest))
        shutil.copymode(target, part)
        os.replace(part, target)
    except BaseException:
        if os.path.exists(part):
            os.remove(part)
        raise


def retire():
    """Undo what the plugin did; Files shows it when next started."""
    try:
        retire_menu()
    except (OSError, UnicodeError):
        pass
    try:
        if os.path.exists(ASIDE) and not os.path.exists(LOCALSEND):
            os.replace(ASIDE, LOCALSEND)
        for compiled in glob.glob(os.path.join(HERE, "__pycache__", "yonder_send.*.pyc")):
            os.remove(compiled)
        os.remove(os.path.abspath(__file__))
    except OSError:
        pass


class SendWithYonderAction(GObject.GObject, Nautilus.MenuProvider):
    def _selected_paths(self, files):
        paths = []

        for file in files:
            location = file.get_location()
            if not location:
                continue

            path = location.get_path()
            if path and path not in paths:
                paths.append(path)

        return paths

    def _make_item(self, paths):
        if len(paths) == 1:
            label = "Send with Yonder"
        elif any(os.path.isdir(path) for path in paths):
            label = "Send %d items with Yonder" % len(paths)
        else:
            label = "Send %d files with Yonder" % len(paths)
        item = Nautilus.MenuItem(
            name="YonderNautilus::send_with_yonder",
            label=label,
            icon="yonder",
        )
        item.connect("activate", self._on_activate, paths)
        return item

    def _on_activate(self, _menu, paths):
        Gio.Subprocess.new(["bash", HELPER, "files"] + paths, Gio.SubprocessFlags.NONE)

    def get_file_items(self, *args):
        if not os.path.isfile(HELPER):
            retire()
            return []

        files = args[0] if len(args) == 1 else args[1]
        paths = self._selected_paths(files)

        if not paths:
            return []

        return [self._make_item(paths)]
