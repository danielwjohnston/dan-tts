"""dan-tts for Calibre: make an MP3 audiobook (and SRT captions) from a book in the library.

Calibre loads this file for the plugin metadata. The GUI class lives in ui.py, so the
command-line tools never import Qt.
"""

from calibre.customize import InterfaceActionBase


class DanTTSPlugin(InterfaceActionBase):
    name = "dan-tts"
    description = "Make an MP3 audiobook and SRT captions from a book, using a dan-tts server"
    supported_platforms = ["windows", "osx", "linux"]
    author = "Daniel Johnston"
    version = (0, 1, 0)
    minimum_calibre_version = (7, 0, 0)
    actual_plugin = "calibre_plugins.dan_tts.ui:DanTTSAction"

    def is_customizable(self):
        return True

    def config_widget(self):
        from calibre_plugins.dan_tts.config import ConfigWidget

        return ConfigWidget()

    def save_settings(self, config_widget):
        config_widget.save_settings()
