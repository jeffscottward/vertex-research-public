#ifndef VERTEX_KERNEL_BRIDGE_V1_H
#define VERTEX_KERNEL_BRIDGE_V1_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define VERTEX_KERNEL_BRIDGE_ABI_VERSION 1
#define VERTEX_KERNEL_MAX_INPUT_BYTES ((size_t)4194304)
#define VERTEX_KERNEL_MAX_OUTPUT_BYTES ((size_t)2000000)
#define VERTEX_KERNEL_MAX_BUNDLE_BYTES ((size_t)8388608)
#define VERTEX_KERNEL_MAX_IDENTITY_BYTES ((size_t)4096)

enum vertex_kernel_bridge_status_v1 {
    VERTEX_KERNEL_OK = 0,
    VERTEX_KERNEL_INVALID_ARGUMENT = 1,
    VERTEX_KERNEL_INPUT_TOO_LARGE = 2,
    VERTEX_KERNEL_OUTPUT_TOO_SMALL = 3,
    VERTEX_KERNEL_AUTHORITY_UNAVAILABLE = 4,
    VERTEX_KERNEL_FAILURE = 5,
    VERTEX_KERNEL_PANIC = 6,
    VERTEX_KERNEL_OUTPUT_TOO_LARGE = 7
};

/* Caller owns every byte. No allocation/handle crosses the ABI and no pointer
 * survives a call. Nonempty ranges must be live readable/writable allocations
 * of the declared size; all ranges (including written) must be disjoint.
 * Inputs must not mutate until return. Written must be aligned for size_t.
 * Zero-length ranges may be NULL. Pointer arithmetic checks CANNOT establish
 * memory validity or prevent use-after-free: these are caller obligations.
 *
 * Initialize *written=0. OK writes exactly *written bytes, no trailing NUL.
 * OUTPUT_TOO_SMALL writes the required byte count without touching output.
 * Other failures never produce a usable response. Invalid argument/oversize
 * failures may leave written unchanged; all other failure counts remain zero.
 * Output beyond the returned count is unspecified and must not be consumed.
 * No partial success, implicit retry, logging callback or remote IO is provided.
 * A successful rejected JSON envelope is a domain denial, NOT an ABI error.
 *
 * Calls are stateless and reentrant with distinct output buffers. Authority is
 * validated every time. Catch-unwind bounds Rust unwind panics only; allocation
 * failure/abort, process faults and invalid foreign pointers require process
 * isolation. A panic hook may still emit native diagnostics. Bounds are not
 * a proof of maximum RSS or execution time. Never invoke in a real-time callback.
 */
int32_t vertex_kernel_bridge_identity_v1(
    uint8_t *output, size_t capacity, size_t *written);

int32_t vertex_kernel_bridge_validate_bundle_v1(
    const uint8_t *bundle, size_t bundle_len,
    const uint8_t *bundle_sha256, size_t pin_len);

int32_t vertex_kernel_bridge_evaluate_v1(
    const uint8_t *bundle, size_t bundle_len,
    const uint8_t *bundle_sha256, size_t pin_len,
    const uint8_t *input, size_t input_len,
    uint8_t *output, size_t capacity, size_t *written);

#ifdef __cplusplus
}
#endif
#endif
