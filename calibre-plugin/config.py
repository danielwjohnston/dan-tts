from calibre.utils.config import JSONConfig
from qt.core import QFormLayout, QLineEdit, QWidget

prefs = JSONConfig("plugins/dan_tts")
prefs.defaults["server_url"] = "http://127.0.0.1:8000"
prefs.defaults["voice"] = "en-US-AriaNeural"


class ConfigWidget(QWidget):
    def __init__(self):
        super().__init__()
        layout = QFormLayout(self)
        self.server_url = QLineEdit(prefs["server_url"], self)
        self.server_url.setToolTip("Base URL of a running dan-tts server, e.g. http://127.0.0.1:8000")
        self.voice = QLineEdit(prefs["voice"], self)
        self.voice.setToolTip("Microsoft Edge voice name, e.g. en-US-AriaNeural")
        layout.addRow("Server URL:", self.server_url)
        layout.addRow("Voice:", self.voice)

    def save_settings(self):
        prefs["server_url"] = self.server_url.text().strip()
        prefs["voice"] = self.voice.text().strip()
