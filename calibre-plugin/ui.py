import os
import shutil
import tempfile

from calibre.gui2 import error_dialog, info_dialog
from calibre.gui2.actions import InterfaceAction
from calibre.gui2.threaded_jobs import ThreadedJob
from calibre_plugins.dan_tts.config import prefs
from calibre_plugins.dan_tts.dan_tts_core import SUPPORTED_FORMATS, extract_text, make_audiobook


def run_book(server_url, voice, source_path, source_format):
    """Runs in a worker thread. Returns the paths of the MP3 and SRT files it wrote."""
    text = extract_text(source_path, source_format)
    mp3_bytes, srt_text = make_audiobook(server_url, text, voice)
    workdir = tempfile.mkdtemp(prefix="dan-tts-")
    mp3_path = os.path.join(workdir, "audiobook.mp3")
    srt_path = os.path.join(workdir, "audiobook.srt")
    with open(mp3_path, "wb") as handle:
        handle.write(mp3_bytes)
    with open(srt_path, "w", encoding="utf-8") as handle:
        handle.write(srt_text)
    return mp3_path, srt_path, workdir


class DanTTSAction(InterfaceAction):
    name = "dan-tts"
    action_spec = ("Make audiobook", None, "Make an MP3 audiobook from the selected book", None)
    action_type = "current"

    def genesis(self):
        self.qaction.triggered.connect(self.make_audiobooks)

    def make_audiobooks(self):
        rows = self.gui.library_view.selectionModel().selectedRows()
        if not rows:
            return error_dialog(self.gui, "No book selected", "Select a book first.", show=True)
        db = self.gui.current_db.new_api
        model = self.gui.library_view.model()
        queued = 0
        for row in rows:
            book_id = model.id(row)
            formats = {fmt.upper(): fmt for fmt in db.formats(book_id)}
            source_format = next((fmt for fmt in SUPPORTED_FORMATS if fmt in formats), None)
            if source_format is None:
                continue
            title = db.field_for("title", book_id) or f"book {book_id}"
            source_path = db.format_abspath(book_id, formats[source_format])
            job = ThreadedJob(
                "dan-tts",
                f"Making audiobook: {title}",
                run_book,
                (prefs["server_url"], prefs["voice"], source_path, source_format),
                {},
                self.finished,
                killable=False,
            )
            job.book_id = book_id
            job.title = title
            self.gui.job_manager.run_threaded_job(job)
            queued += 1
        if not queued:
            error_dialog(
                self.gui,
                "Nothing to convert",
                "The selected books have no EPUB or TXT format. Add one and try again.",
                show=True,
            )

    def finished(self, job):
        if job.failed:
            return error_dialog(
                self.gui,
                f"Audiobook failed: {job.title}",
                f"{job.exception}\n\nCheck that the dan-tts server URL is correct and running.",
                show=True,
            )
        mp3_path, srt_path, workdir = job.result
        db = self.gui.current_db.new_api
        try:
            db.add_format(job.book_id, "MP3", mp3_path, replace=True, run_hooks=False)
            db.add_format(job.book_id, "SRT", srt_path, replace=True, run_hooks=False)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
        self.gui.library_view.model().refresh_ids([job.book_id])
        info_dialog(self.gui, "Audiobook ready", f"Added MP3 and SRT to: {job.title}", show=True)
