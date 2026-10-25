#!/usr/bin/env bash
# Fine-tune a Piper voice on a validated personal dataset.
#
#   voice-training/train.sh <dataset_dir> <piper1-gpl checkout> <voice_name> <espeak_voice> [checkpoint]
#
# Example:
#   voice-training/train.sh voice-training/dataset ~/piper1-gpl dan en-us ~/checkpoints/medium.ckpt
#
# Steps: validate the dataset, convert metadata.csv to Piper's `file.wav|text` format,
# then run `piper.train fit` with the flags from piper1-gpl's docs/TRAINING.md.
# Untested here: this container has no GPU. Run it on the training machine.
set -euo pipefail

if [[ $# -lt 4 ]]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

DATASET=$(realpath "$1")
PIPER_DIR=$(realpath "$2")
VOICE_NAME=$3
ESPEAK_VOICE=$4
CHECKPOINT=${5:-}

HERE=$(dirname "$(realpath "$0")")

echo "==> Validating dataset"
python3 "$HERE/validate_dataset.py" "$DATASET"

# Piper expects `<wav file name>|<text>` with audio in --data.audio_dir.
PIPER_CSV="$DATASET/piper_metadata.csv"
awk -F'|' 'BEGIN { OFS = "|" } { print $1 ".wav", substr($0, length($1) + 2) }' \
  "$DATASET/metadata.csv" > "$PIPER_CSV"
echo "==> Wrote $PIPER_CSV ($(wc -l < "$PIPER_CSV") clips)"

if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
else
  echo "warning: nvidia-smi not found; training will fall back to CPU or fail" >&2
fi

cd "$PIPER_DIR"
# shellcheck disable=SC1091
source .venv/bin/activate

ARGS=(
  fit
  --data.voice_name "$VOICE_NAME"
  --data.csv_path "$PIPER_CSV"
  --data.audio_dir "$DATASET/wavs/"
  --model.sample_rate 22050
  --data.espeak_voice "$ESPEAK_VOICE"
  --data.cache_dir "$DATASET/cache/"
  --data.config_path "$DATASET/config.json"
  --data.batch_size 32
  --trainer.max_epochs 100
)
if [[ -n "$CHECKPOINT" ]]; then
  ARGS+=(--ckpt_path "$(realpath "$CHECKPOINT")")
fi

echo "==> Starting fine-tune"
python3 -m piper.train "${ARGS[@]}"
