"""Package calibre-plugin/ into dist/dan_tts_calibre.zip, ready for Calibre's plugin loader."""

import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "calibre-plugin"
OUTPUT = ROOT / "dist" / "dan_tts_calibre.zip"


def build():
    OUTPUT.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(SOURCE.iterdir()):
            if path.is_file() and path.suffix != ".pyc" and "__pycache__" not in path.parts:
                archive.write(path, path.name)
    return OUTPUT


if __name__ == "__main__":
    print(build())
