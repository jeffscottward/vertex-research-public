"""Bounded canonical RFC4648 bytes for source approval/replay refinements.

Ordinary WorkerBytes structural fields do not implicitly invoke this decoder.
"""

import base64
import binascii

from .codec import ContractError

MAX_REPLAY_BLOB_BYTES = 1_048_576
MAX_REPLAY_BLOB_BASE64 = 1_398_104
MAX_REPLAY_DECODED_BYTES = 8_388_608
MAX_REPLAY_WIRE_BYTES = 12_582_912


def decode_canonical_base64(value: str) -> bytes:
    if type(value) is not str or not 4 <= len(value) <= MAX_REPLAY_BLOB_BASE64 or not value.isascii():
        raise ContractError("Expected bounded canonical base64 string")
    # The encoded input length is checked before allocating decoded bytes.
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ContractError("Invalid canonical base64") from exc
    if not 0 < len(decoded) <= MAX_REPLAY_BLOB_BYTES:
        raise ContractError("Decoded replay blob exceeds byte bound")
    if base64.b64encode(decoded).decode("ascii") != value:
        raise ContractError("Noncanonical base64 pad bits or spelling")
    return decoded
