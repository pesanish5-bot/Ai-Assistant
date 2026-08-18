"""Exercise Ultron's local speaker/challenge prototype without unlocking Windows."""

from __future__ import annotations

import argparse
import time

from .interaction import SessionState
from .locked_auth_workflow import build_locked_authentication_workflow


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name")
    parser.add_argument("--microphone-device", type=int)
    parser.add_argument("--output-device", type=int)
    args = parser.parse_args()
    try:
        workflow = build_locked_authentication_workflow(
            speaker_name=args.name,
            microphone_device=args.microphone_device,
            output_device=args.output_device,
        )
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as error:
        print(f"Authentication unavailable: {error}")
        return 2
    print("Local authentication prototype only; it cannot and will not unlock Windows.")
    decision = workflow.start(
        time.time(),
        activation_method="double_clap",
        session_state=SessionState.LOCKED,
    )
    print(decision.public_message)
    return 0 if decision.authenticated else 1


if __name__ == "__main__":
    raise SystemExit(main())
