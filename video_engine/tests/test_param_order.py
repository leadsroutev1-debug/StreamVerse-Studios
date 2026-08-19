"""
Regression tests for the official LTX-2.3 Space contract.

Correct positional order:
    0 image
    1 prompt
    2 duration
    3 enhance_prompt
    4 seed
    5 randomize_seed
    6 height
    7 width

Production StreamVerse geometry:
    width=1024, height=1536 (native 9:16 high-resolution preset)
"""

from video_engine.providers.ltx import (
    PRODUCTION_HEIGHT,
    PRODUCTION_WIDTH,
    build_predict_args,
)


def test_ltx_positional_argument_order():
    args = build_predict_args(
        "/tmp/scene.jpg",
        "cinematic push in",
        8.0,
        False,
        123456,
        False,
        PRODUCTION_HEIGHT,
        PRODUCTION_WIDTH,
    )

    assert len(args) == 8
    assert args[1] == "cinematic push in"
    assert args[2] == 8.0
    assert args[3] is False
    assert args[4] == 123456
    assert args[5] is False
    assert args[6] == PRODUCTION_HEIGHT == 1536
    assert args[7] == PRODUCTION_WIDTH == 1024

    # Guard against the previously-reported width/height swap.
    assert (args[6], args[7]) != (1024, 1536)
