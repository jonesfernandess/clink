#!/usr/bin/env python3
"""Transcribe audio using faster-whisper. Outputs plain text to stdout."""

import sys
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(audio_path, beam_size=5)

    text = " ".join(segment.text.strip() for segment in segments)
    print(text)

if __name__ == "__main__":
    main()
