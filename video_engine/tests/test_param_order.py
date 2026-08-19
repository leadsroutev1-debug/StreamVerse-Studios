"""
Regression test — LTX positional argument order.

This exists specifically to prevent reintroducing the old bug where
width/height were swapped or enhance_prompt/seed/randomize_seed were
placed in the wrong slots. See refactor spec §17.

Correct order:
    0 image
    1 prompt
    2 duration
    3 enhance_prompt
    4 seed
    5 randomize_seed
    6 height
    7 width
"""
from video_engine.providers.ltx import build_predict_args


def test_ltx_positional_argument_order():
    args = build_predict_args(
        "/tmp/scene.jpg",  # image_path
        "cinematic push in",  # prompt
        8.0,  # duration
        False,  # enhance_prompt
        123456,  # seed
        False,  # randomize_seed
        1536,  # height
        1024,  # width
    )

    assert len(args) == 8

    # args[0] is a handle_file(...) FileData wrapper for the image path.
    assert args[1] == "cinematic push in"
    assert args[2] == 8.0
    assert args[3] is False  # enhance_prompt
    assert args[4] == 123456  # seed
    assert args[5] is False  # randomize_seed
    assert args[6] == 1536  # height
    assert args[7] == 1024  # width

    # Explicitly guard against the previously-reported wrong order:
    # image, prompt, duration, WIDTH, HEIGHT, seed, randomize_seed, enhance_prompt
    wrong_order_would_have = (args[6], args[7]) == (1024, 1536)
    assert not wrong_order_would_have, "height/width appear swapped — regression!"
