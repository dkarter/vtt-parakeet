import json
import sys

from parakeet_mlx import from_pretrained


def main() -> int:
    if len(sys.argv) < 2:
        print(
            json.dumps({"type": "error", "message": "Missing model name"}), flush=True
        )
        return 1

    model_name = sys.argv[1]

    try:
        model = from_pretrained(model_name)
        print(json.dumps({"type": "ready"}), flush=True)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"type": "error", "message": str(exc)}), flush=True)
        return 1

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"type": "error", "message": str(exc)}), flush=True)
            continue

        if payload.get("type") == "shutdown":
            print(json.dumps({"type": "shutdown"}), flush=True)
            return 0

        if payload.get("type") != "transcribe":
            print(
                json.dumps({"type": "error", "message": "Unsupported request type"}),
                flush=True,
            )
            continue

        audio_path = payload.get("audioPath")
        if not audio_path:
            print(
                json.dumps({"type": "error", "message": "Missing audioPath"}),
                flush=True,
            )
            continue

        try:
            result = model.transcribe(audio_path)
            print(
                json.dumps({"type": "result", "text": result.text.strip()}), flush=True
            )
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"type": "error", "message": str(exc)}), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
